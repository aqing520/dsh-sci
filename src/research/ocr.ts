import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { ResearchOcrPage, ResearchOcrProvider, ResearchOcrResult } from "./document.js";

export interface CommandOcrProviderOptions {
  provider?: string;
  command: string;
  args?: string[] | ((filePath: string) => string[]);
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

function stopProcess(child: ChildProcess): void {
  if (!child.pid) { child.kill(); return; }
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false, stdio: "ignore" });
    killer.unref();
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
}

interface CommandRunOptions { cwd?: string; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal; }

async function runCommand(command: string, args: string[], options: CommandRunOptions): Promise<string> {
  if (!command.trim()) throw new Error("OCR command is required");
  if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new DOMException("OCR cancelled", "AbortError");
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let truncated = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); if (error) reject(error); else resolve(stdout); };
    const abort = () => { stopProcess(child); finish(options.signal?.reason instanceof Error ? options.signal.reason : new DOMException("OCR cancelled", "AbortError")); };
    const timer = setTimeout(() => { timedOut = true; stopProcess(child); }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { const next = stdout + chunk.toString("utf8"); if (Buffer.byteLength(next, "utf8") > options.maxOutputBytes) { truncated = true; stdout = next.slice(0, options.maxOutputBytes); stopProcess(child); } else stdout = next; });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4_000); });
    options.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (settled) return;
      if (timedOut) { finish(new Error(`OCR command timed out after ${options.timeoutMs} ms`)); return; }
      if (truncated) { finish(new Error(`OCR command output exceeds ${options.maxOutputBytes} bytes`)); return; }
      if (code !== 0) { finish(new Error(`OCR command exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}${stderr.trim() ? `: ${stderr.trim()}` : ""}`)); return; }
      finish();
    });
  });
}

function parseConfidence(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined; }

function parseOcrOutput(value: string): ResearchOcrResult {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("OCR command returned no text");
  try {
    const parsed = JSON.parse(trimmed) as { text?: unknown; pageTexts?: unknown; pages?: unknown; confidence?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.text === "string" && parsed.text.trim()) {
      const pageTexts = Array.isArray(parsed.pageTexts) ? parsed.pageTexts.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : undefined;
      const pages = Array.isArray(parsed.pages) ? parsed.pages.filter((item): item is ResearchOcrPage => Boolean(item && typeof item === "object" && typeof (item as any).text === "string" && (item as any).text.trim())).map((item: any) => ({ text: item.text.trim(), ...(parseConfidence(item.confidence) === undefined ? {} : { confidence: parseConfidence(item.confidence) }) })) : undefined;
      const confidence = parseConfidence(parsed.confidence);
      return { text: parsed.text.trim(), ...(pageTexts?.length ? { pageTexts } : {}), ...(pages?.length ? { pages } : {}), ...(confidence === undefined ? {} : { confidence }) };
    }
  } catch { /* Plain text is the default command protocol. */ }
  return { text: trimmed };
}

/**
 * Adapt a local OCR executable or wrapper to the ResearchOcrProvider boundary.
 * The executable receives the PDF path as the final argument and writes either
 * plain OCR text or {"text": "...", "pageTexts": ["..."]} JSON to stdout.
 */
export function createCommandOcrProvider(options: CommandOcrProviderOptions): ResearchOcrProvider {
  if (typeof options.command !== "string" || !options.command.trim()) throw new Error("OCR command is required");
  const provider = options.provider?.trim() || "command-ocr";
  const timeoutMs = Math.max(1_000, Math.min(30 * 60_000, Math.floor(options.timeoutMs ?? 120_000)));
  const maxOutputBytes = Math.max(1_024, Math.min(20 * 1024 * 1024, Math.floor(options.maxOutputBytes ?? 2 * 1024 * 1024)));
  return {
    provider,
    recognize(input) {
      if (input.signal?.aborted) return Promise.reject(input.signal.reason instanceof Error ? input.signal.reason : new DOMException("OCR cancelled", "AbortError"));
      const args = typeof options.args === "function" ? options.args(input.filePath) : [...(options.args ?? [])];
      return new Promise((resolve, reject) => {
        const child = spawn(options.command, [...args, input.filePath], { cwd: options.cwd, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        let truncated = false;
        const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); input.signal?.removeEventListener("abort", abort); if (error) reject(error); else { try { resolve(parseOcrOutput(stdout)); } catch (parseError) { reject(parseError); } } };
        const abort = () => { stopProcess(child); finish(input.signal?.reason instanceof Error ? input.signal.reason : new DOMException("OCR cancelled", "AbortError")); };
        const timer = setTimeout(() => { timedOut = true; stopProcess(child); }, timeoutMs);
        child.stdout?.on("data", (chunk: Buffer) => { const next = stdout + chunk.toString("utf8"); if (Buffer.byteLength(next, "utf8") > maxOutputBytes) { truncated = true; stdout = next.slice(0, maxOutputBytes); stopProcess(child); } else stdout = next; });
        child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4_000); });
        if (input.signal?.aborted) abort(); else input.signal?.addEventListener("abort", abort, { once: true });
        child.once("error", (error) => finish(error));
        child.once("close", (code, signal) => {
          if (settled) return;
          if (timedOut) { finish(new Error(`OCR command timed out after ${timeoutMs} ms`)); return; }
          if (truncated) { finish(new Error(`OCR command output exceeds ${maxOutputBytes} bytes`)); return; }
          if (code !== 0) { finish(new Error(`OCR command exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}${stderr.trim() ? `: ${stderr.trim()}` : ""}`)); return; }
          finish();
        });
      });
    },
  };
}

export interface HttpOcrProviderOptions {
  endpoint: string;
  apiKey?: string;
  provider?: string;
  timeoutMs?: number;
  maxRequestBytes?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

/** Generic opt-in cloud OCR adapter using a JSON base64 document contract. */
export function createHttpOcrProvider(options: HttpOcrProviderOptions): ResearchOcrProvider {
  let endpoint: string;
  try { endpoint = new URL(options.endpoint).toString(); } catch { throw new Error("OCR endpoint must be a valid URL"); }
  const provider = options.provider?.trim() || "http-ocr";
  const timeoutMs = Math.max(1_000, Math.min(30 * 60_000, Math.floor(options.timeoutMs ?? 120_000)));
  const maxRequestBytes = Math.max(1_024, Math.min(50 * 1024 * 1024, Math.floor(options.maxRequestBytes ?? 20 * 1024 * 1024)));
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    provider,
    async recognize(input) {
      if (input.data.byteLength > maxRequestBytes) throw new Error(`OCR request exceeds ${maxRequestBytes} bytes`);
      const controller = new AbortController();
      const abort = () => controller.abort(input.signal?.reason);
      const timer = setTimeout(() => controller.abort(new Error(`OCR request timed out after ${timeoutMs} ms`)), timeoutMs);
      input.signal?.addEventListener("abort", abort, { once: true });
      try {
        const response = await fetchImpl(endpoint, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}), ...(options.headers ?? {}) }, body: JSON.stringify({ fileName: path.basename(input.filePath), contentBase64: Buffer.from(input.data).toString("base64"), maxText: input.maxText }), signal: controller.signal });
        const body = await response.text();
        if (!response.ok) throw new Error(`OCR service failed with HTTP ${response.status}${body.trim() ? `: ${body.trim().slice(0, 500)}` : ""}`);
        return parseOcrOutput(body);
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new DOMException("OCR cancelled", "AbortError");
        if (controller.signal.aborted) throw new Error(`OCR request timed out after ${timeoutMs} ms`);
        throw error;
      } finally { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); }
    },
  };
}

export interface TesseractOcrProviderOptions {
  provider?: string;
  rendererCommand?: string;
  tesseractCommand?: string;
  rendererArgs?: (input: { filePath: string; outputPrefix: string; dpi: number; maxPages: number }) => string[];
  tesseractArgs?: (input: { imagePath: string; language: string }) => string[];
  language?: string;
  dpi?: number;
  maxPages?: number;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

/**
 * Render a PDF into page images and OCR each page with Tesseract. Both
 * executables are launched with shell:false; callers can inject command
 * paths/argument builders for packaged installations and deterministic tests.
 */
export function createTesseractOcrProvider(options: TesseractOcrProviderOptions = {}): ResearchOcrProvider {
  const provider = options.provider?.trim() || "tesseract-ocr";
  const rendererCommand = options.rendererCommand?.trim() || (process.platform === "win32" ? "pdftoppm.exe" : "pdftoppm");
  const tesseractCommand = options.tesseractCommand?.trim() || (process.platform === "win32" ? "tesseract.exe" : "tesseract");
  const language = options.language?.trim() || "eng";
  const dpi = Math.max(72, Math.min(600, Math.floor(options.dpi ?? 200)));
  const maxPages = Math.max(1, Math.min(200, Math.floor(options.maxPages ?? 50)));
  const timeoutMs = Math.max(1_000, Math.min(30 * 60_000, Math.floor(options.timeoutMs ?? 5 * 60_000)));
  const maxOutputBytes = Math.max(1_024, Math.min(20 * 1024 * 1024, Math.floor(options.maxOutputBytes ?? 2 * 1024 * 1024)));
  return {
    provider,
    async recognize(input) {
      if (input.signal?.aborted) throw input.signal.reason instanceof Error ? input.signal.reason : new DOMException("OCR cancelled", "AbortError");
      const tempRoot = await mkdtemp(path.join(tmpdir(), "dsh-sci-tesseract-"));
      const outputPrefix = path.join(tempRoot, "page");
      try {
        const rendererArgs = options.rendererArgs?.({ filePath: input.filePath, outputPrefix, dpi, maxPages }) ?? ["-png", "-r", String(dpi), "-f", "1", "-l", String(maxPages), input.filePath, outputPrefix];
        await runCommand(rendererCommand, rendererArgs, { cwd: options.cwd, timeoutMs, maxOutputBytes: 1_024 * 1_024, signal: input.signal });
        const files = (await readdir(tempRoot)).filter((file) => new RegExp(`^${escapeRegExp(path.basename(outputPrefix))}-\\d+\\.png$`, "iu").test(file)).sort((a, b) => Number(/-(\\d+)\\.png$/iu.exec(a)?.[1] ?? 0) - Number(/-(\\d+)\\.png$/iu.exec(b)?.[1] ?? 0));
        if (!files.length) throw new Error("PDF renderer produced no page images");
        const pageTexts: string[] = [];
        for (const file of files.slice(0, maxPages)) {
          const imagePath = path.join(tempRoot, file);
          const tesseractArgs = options.tesseractArgs?.({ imagePath, language }) ?? [imagePath, "stdout", "-l", language];
          const text = (await runCommand(tesseractCommand, tesseractArgs, { cwd: options.cwd, timeoutMs, maxOutputBytes, signal: input.signal })).trim();
          pageTexts.push(text);
        }
        const text = pageTexts.join("\n").trim().slice(0, input.maxText);
        if (!text) throw new Error("Tesseract returned no text");
        return { text, pageTexts: pageTexts.filter(Boolean).map((page) => page.slice(0, input.maxText)) };
      } finally { await rm(tempRoot, { recursive: true, force: true }); }
    },
  };
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"); }
