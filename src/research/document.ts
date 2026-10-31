import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface ResearchDocument {
  schema: "dsh-sci.research-document.v1";
  documentId: string;
  path: string;
  mediaType: "text/plain" | "text/markdown" | "text/html" | "application/json" | "application/pdf";
  title: string;
  text: string;
  contentHash: string;
  bytes: number;
  truncated: boolean;
  extraction: "text" | "ocr" | "ocr-required";
  ocrProvider?: string;
  ocrConfidence?: number;
  ocrPageConfidences?: Array<number | null>;
  ocrError?: string;
  chunks: ResearchDocumentChunk[];
}

export interface ResearchDocumentChunk { chunkId: string; index: number; text: string; startOffset: number; endOffset: number; locator: string; page?: number; confidence?: number; }
export interface ResearchOcrPage { text: string; confidence?: number; }
export interface ResearchOcrResult { text: string; pageTexts?: string[]; pages?: ResearchOcrPage[]; confidence?: number; }
export interface ResearchOcrProvider {
  readonly provider: string;
  recognize(input: { filePath: string; data: Uint8Array; maxText: number; signal?: AbortSignal }): Promise<ResearchOcrResult>;
}

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 200_000;
const CHUNK_SIZE = 4_000;

function mediaType(file: string): ResearchDocument["mediaType"] {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".md" || extension === ".markdown") return "text/markdown";
  if (extension === ".html" || extension === ".htm") return "text/html";
  if (extension === ".json") return "application/json";
  if (extension === ".pdf") return "application/pdf";
  if ([".txt", ".text", ".csv", ".tsv", ".tex"].includes(extension)) return "text/plain";
  throw new Error(`unsupported research document type: ${extension || "unknown"}`);
}

function plainText(input: string, type: ResearchDocument["mediaType"]): string {
  if (type === "application/json") {
    try { return JSON.stringify(JSON.parse(input), null, 2); } catch { throw new Error("research JSON document is invalid"); }
  }
  if (type === "text/html") return input.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, "").replace(/<[^>]+>/gu, " ").replace(/&nbsp;/giu, " ").replace(/&amp;/giu, "&").replace(/\s+/gu, " ").trim();
  return input.replace(/\r\n?/gu, "\n").trim();
}

function fallbackPdfText(input: string): string {
  const chunks: string[] = [];
  for (const match of input.matchAll(/\(([^()]*)\)\s*Tj/gu)) chunks.push(match[1].replace(/\\([\\()])/gu, "$1"));
  for (const match of input.matchAll(/\[([^\]]+)\]\s*TJ/gu)) for (const text of match[1].matchAll(/\(([^()]*)\)/gu)) chunks.push(text[1].replace(/\\([\\()])/gu, "$1"));
  return chunks.join(" ").replace(/\\n/gu, "\n").replace(/\s+/gu, " ").trim();
}

async function extractPdfText(buffer: Buffer): Promise<{ text: string; pageTexts: string[]; extraction: "text" | "ocr-required"; pageConfidences?: Array<number | undefined> }> {
  try {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = getDocument({ data: new Uint8Array(buffer), useWorkerFetch: false } as any);
    const pdf = await loadingTask.promise;
    const pageTexts: string[] = [];
    try {
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const content = await page.getTextContent();
        pageTexts.push(content.items.map((item: any) => typeof item.str === "string" ? item.str : "").join(" ").replace(/\s+/gu, " ").trim());
      }
    } finally { await (pdf as any).destroy?.(); await (loadingTask as any).destroy?.(); }
    const text = pageTexts.join("\n");
    return { text, pageTexts, extraction: text.trim() ? "text" : "ocr-required" };
  } catch {
    const text = fallbackPdfText(buffer.toString("latin1"));
    return { text, pageTexts: [], extraction: text.trim() ? "text" : "ocr-required" };
  }
}

function confidence(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined; }

function ocrPages(result: ResearchOcrResult): ResearchOcrPage[] {
  if (Array.isArray(result.pages)) return result.pages.filter((page): page is ResearchOcrPage => Boolean(page && typeof page === "object" && typeof page.text === "string")).map((page) => ({ text: page.text.trim(), ...(confidence(page.confidence) === undefined ? {} : { confidence: confidence(page.confidence) }) }));
  return Array.isArray(result.pageTexts) ? result.pageTexts.filter((page): page is string => typeof page === "string").map((text) => ({ text: text.trim() })) : [];
}

function titleFor(file: string, text: string): string {
  const heading = /^#\s+(.+)$/mu.exec(text)?.[1]?.trim();
  return heading || path.basename(file, path.extname(file));
}

export async function parseResearchDocument(file: string, options: { maxBytes?: number; maxText?: number; ocr?: ResearchOcrProvider; signal?: AbortSignal } = {}): Promise<ResearchDocument> {
  const resolved = path.resolve(file);
  const info = await stat(resolved);
  const limit = Math.max(1, Math.min(MAX_BYTES, options.maxBytes ?? MAX_BYTES));
  if (!info.isFile()) throw new Error("research document must be a regular file");
  if (info.size > limit) throw new Error(`research document exceeds ${limit} bytes`);
  const buffer = await readFile(resolved);
  const type = mediaType(resolved);
  const textLimit = Math.max(1, Math.min(MAX_TEXT, options.maxText ?? MAX_TEXT));
  let extractedPdf = type === "application/pdf" ? await extractPdfText(buffer) : undefined;
  let ocrProvider: string | undefined;
  let ocrConfidence: number | undefined;
  let ocrPageConfidences: Array<number | null> | undefined;
  let ocrError: string | undefined;
  if (extractedPdf?.extraction === "ocr-required" && options.ocr) {
    try {
      const result = await options.ocr.recognize({ filePath: resolved, data: buffer, maxText: textLimit, signal: options.signal });
      if (typeof result?.text === "string" && result.text.trim()) {
        const pages = ocrPages(result);
        const pageTexts = pages.length ? pages.map((page) => page.text) : [result.text.trim()];
        const pageConfidences = pages.map((page) => page.confidence);
        const suppliedPageConfidences = pageConfidences.filter((value): value is number => value !== undefined);
        const aggregate = confidence(result.confidence) ?? (suppliedPageConfidences.length === pages.length && suppliedPageConfidences.length ? suppliedPageConfidences.reduce((sum, value) => sum + value, 0) / suppliedPageConfidences.length : undefined);
        extractedPdf = { text: pageTexts.join("\n"), pageTexts, ...(pageConfidences.length ? { pageConfidences } : {}), extraction: "text" };
        ocrProvider = options.ocr.provider.trim().slice(0, 256) || "ocr";
        ocrConfidence = aggregate;
        ocrPageConfidences = suppliedPageConfidences.length ? pageConfidences.map((value) => value ?? null) : undefined;
      } else ocrError = "OCR provider returned no text";
    } catch (error) { ocrError = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000); }
  }
  const normalized = extractedPdf?.text ?? plainText(buffer.toString("utf8"), type);
  const raw = buffer.toString("utf8");
  const htmlTitle = type === "text/html" ? /<h1\b[^>]*>([\s\S]*?)<\/h1>/iu.exec(raw)?.[1]?.replace(/<[^>]+>/gu, "").trim() : undefined;
  const text = normalized.slice(0, textLimit);
  const documentId = `document-${createHash("sha256").update(`${resolved}\0${buffer.toString("base64")}`).digest("hex").slice(0, 32)}`;
  const chunks: ResearchDocumentChunk[] = [];
  if (extractedPdf?.pageTexts.length) {
    let offset = 0;
    for (let index = 0; index < extractedPdf.pageTexts.length && offset < text.length; index += 1) {
      const pageText = extractedPdf.pageTexts[index];
      const end = Math.min(text.length, offset + pageText.length);
      const pageConfidence = extractedPdf.pageConfidences?.[index];
      for (let start = offset; start < end; start += CHUNK_SIZE) {
        const endOffset = Math.min(end, start + CHUNK_SIZE);
        chunks.push({ chunkId: `${documentId}-page-${index + 1}-${start}`, index: chunks.length, page: index + 1, text: text.slice(start, endOffset), startOffset: start, endOffset, locator: `page ${index + 1}, characters ${start}-${endOffset}`, ...(pageConfidence === undefined ? {} : { confidence: pageConfidence }) });
      }
      offset += pageText.length + 1;
    }
  } else {
    for (let start = 0; start < text.length; start += CHUNK_SIZE) {
      const end = Math.min(text.length, start + CHUNK_SIZE);
      chunks.push({ chunkId: `${documentId}-chunk-${chunks.length + 1}`, index: chunks.length, text: text.slice(start, end), startOffset: start, endOffset: end, locator: `characters ${start}-${end}` });
    }
  }
  const extraction = extractedPdf?.extraction === "text" && ocrProvider ? "ocr" : extractedPdf?.extraction ?? "text";
  return { schema: "dsh-sci.research-document.v1", documentId, path: resolved, mediaType: type, title: htmlTitle || titleFor(resolved, normalized), text, contentHash: createHash("sha256").update(buffer).digest("hex"), bytes: info.size, truncated: normalized.length > textLimit, extraction, ...(ocrProvider ? { ocrProvider } : {}), ...(ocrConfidence === undefined ? {} : { ocrConfidence }), ...(ocrPageConfidences?.length ? { ocrPageConfidences } : {}), ...(ocrError ? { ocrError } : {}), chunks };
}
