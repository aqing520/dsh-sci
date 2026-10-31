import { spawn } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";

export interface CodeSyntaxCheck {
  fileName: string;
  status: "parsed" | "syntax-error" | "parser-unavailable" | "not-checked";
  parser: "node-check" | "none";
  mode?: "module" | "commonjs";
  line?: number;
  message?: string;
}

/** Node's --check parses stdin only: no imports, tests or candidate statements run.
 * The child receives neither NODE_OPTIONS/preload hooks nor provider secrets. */
async function parseJavaScript(content: string, mode: "module" | "commonjs"): Promise<Omit<CodeSyntaxCheck, "fileName">> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(SystemRoot|WINDIR|TEMP|TMP)$/iu.test(name)));
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
  return new Promise((resolve) => {
    let stderr = "", terminal = false;
    const child = spawn(process.execPath, ["--max-old-space-size=64", "--check", `--input-type=${mode}`], { cwd: tmpdir(), env, windowsHide: true, stdio: ["pipe", "ignore", "pipe"], shell: false });
    const finish = (result: Omit<CodeSyntaxCheck, "fileName">) => { if (terminal) return; terminal = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish({ status: "parser-unavailable", parser: "node-check", mode, message: "Static parser time limit reached" }); }, 3000);
    child.on("error", () => finish({ status: "parser-unavailable", parser: "node-check", mode, message: "Static parser could not start" }));
    child.stdin.on("error", () => { /* Close/error handles a parser that exits before stdin drains. */ });
    child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString("utf8")).slice(-8192); });
    child.on("close", (code) => {
      if (code === 0) { finish({ status: "parsed", parser: "node-check", mode }); return; }
      const syntax = stderr.match(/SyntaxError: ([^\r\n]{1,200})/u);
      const line = stderr.match(/\[stdin\]:(\d+)/u)?.[1];
      finish(syntax ? { status: "syntax-error", parser: "node-check", mode, ...(line ? { line: Number(line) } : {}), message: syntax[1] } : { status: "parser-unavailable", parser: "node-check", mode, message: "Static parser failed without a syntax diagnostic" });
    });
    child.stdin.end(content);
  });
}

export async function checkCandidateCodeSyntax(fileName: string, content: string): Promise<CodeSyntaxCheck> {
  if (typeof content !== "string" || Buffer.byteLength(content) > 128 * 1024) throw new Error("Syntax check requires source within the staged file limit");
  const extension = path.extname(fileName).toLowerCase();
  if (![".js", ".mjs", ".cjs"].includes(extension)) return { fileName, status: "not-checked", parser: "none", message: "No static parser configured for this file type" };
  const mode = extension === ".cjs" ? "commonjs" : "module";
  const first = await parseJavaScript(content, mode);
  // .js may be either module type. Parsing either does not determine runtime type.
  if (extension === ".js" && first.status === "syntax-error") {
    const second = await parseJavaScript(content, "commonjs");
    if (second.status !== "syntax-error") return { fileName, ...second };
  }
  return { fileName, ...first };
}
