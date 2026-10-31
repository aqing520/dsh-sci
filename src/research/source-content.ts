import { createHash, randomUUID } from "node:crypto";
import type { ResearchCitation } from "./evidence.js";

export interface SourceContentChunk {
  chunkId: string;
  index: number;
  startOffset: number;
  endOffset: number;
  text: string;
  page?: number;
  confidence?: number;
}

export interface SourceContentVersion {
  schema: "dsh-sci.source-content.v1";
  projectId: string;
  sourceId: string;
  contentVersionId: string;
  retrievedAt: string;
  origin: string;
  accessStatus: "available";
  scope: "abstract" | "full-text";
  extraction: "text" | "ocr";
  truncated: boolean;
  contentHash: string;
  originalHash?: string;
  text: string;
  chunks: SourceContentChunk[];
}

export type SourceContentSummary = Omit<SourceContentVersion, "text" | "chunks"> & { characters: number; chunkCount: number; chunkIndex: Array<Omit<SourceContentChunk, "text">> };
export interface SourceReadReceipt {
  schema: "dsh-sci.source-read.v1";
  readId: string;
  projectId: string;
  sourceId: string;
  contentVersionId: string;
  contentHash: string;
  audience: "agent" | "workspace";
  planId?: string;
  taskId?: string;
  attemptId?: string;
  chunkIds: string[];
  readAt: string;
}

export const SOURCE_TEXT_LIMIT = 200_000;
export const SOURCE_CHUNK_SIZE = 4_000;
export function sourceTextHash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function makeSourceContent(input: Omit<SourceContentVersion, "schema" | "contentVersionId" | "contentHash" | "chunks" | "retrievedAt" | "text" | "accessStatus"> & {
  text: string; segments?: Array<{ startOffset: number; endOffset: number; page?: number; confidence?: number }>;
}): SourceContentVersion {
  const text = input.text.slice(0, SOURCE_TEXT_LIMIT);
  const contentVersionId = `content-${randomUUID()}`;
  const chunks: SourceContentChunk[] = [];
  const append = (start: number, end: number, page?: number, confidence?: number) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) throw new Error("Invalid extraction segment offsets");
    for (let offset = start; offset < end; offset += SOURCE_CHUNK_SIZE) {
      const index = chunks.length;
      const endOffset = Math.min(end, offset + SOURCE_CHUNK_SIZE);
      chunks.push({ chunkId: `${contentVersionId}-${index}`, index, startOffset: offset, endOffset, text: text.slice(offset, endOffset), ...(page === undefined ? {} : { page }), ...(confidence === undefined ? {} : { confidence }) });
    }
  };
  if (input.segments?.length) {
    for (const segment of input.segments) append(segment.startOffset, Math.min(text.length, segment.endOffset), segment.page, segment.confidence);
  } else append(0, text.length);
  const { segments: _segments, ...fields } = input;
  const content: SourceContentVersion = { ...fields, schema: "dsh-sci.source-content.v1", accessStatus: "available", contentVersionId, retrievedAt: new Date().toISOString(), text, contentHash: sourceTextHash(text), truncated: input.truncated || input.text.length > SOURCE_TEXT_LIMIT, chunks };
  return validateSourceContent(content, input.projectId);
}

/** Validate persisted content as well as fresh extraction. Offsets use JS UTF-16 characters. */
export function validateSourceContent(content: SourceContentVersion, projectId: string): SourceContentVersion {
  if (!content || content.schema !== "dsh-sci.source-content.v1" || content.projectId !== projectId || !content.sourceId || !/^content-[a-z0-9-]+$/u.test(content.contentVersionId)) throw new Error("Invalid source content identity");
  if (typeof content.text !== "string" || !content.text.trim() || content.text.length > SOURCE_TEXT_LIMIT || sourceTextHash(content.text) !== content.contentHash) throw new Error("Source content hash or text is invalid");
  if (content.accessStatus !== "available" || !["abstract", "full-text"].includes(content.scope) || !["text", "ocr"].includes(content.extraction) || typeof content.truncated !== "boolean" || !Array.isArray(content.chunks) || !content.chunks.length || content.chunks.length > SOURCE_TEXT_LIMIT) throw new Error("Source content format is invalid");
  let previous = 0;
  for (const [index, chunk] of content.chunks.entries()) {
    if (chunk.index !== index || chunk.chunkId !== `${content.contentVersionId}-${index}` || !Number.isSafeInteger(chunk.startOffset) || !Number.isSafeInteger(chunk.endOffset) || chunk.startOffset < previous || chunk.endOffset <= chunk.startOffset || chunk.endOffset > content.text.length || chunk.text.length > SOURCE_CHUNK_SIZE || chunk.text !== content.text.slice(chunk.startOffset, chunk.endOffset) || content.text.slice(previous, chunk.startOffset).trim()) throw new Error("Source content chunk is invalid");
    if (chunk.page !== undefined && (!Number.isSafeInteger(chunk.page) || chunk.page < 1)) throw new Error("Source content page is invalid");
    if (chunk.confidence !== undefined && (!Number.isFinite(chunk.confidence) || chunk.confidence < 0 || chunk.confidence > 1)) throw new Error("Source content confidence is invalid");
    previous = chunk.endOffset;
  }
  if (content.text.slice(previous).trim()) throw new Error("Source chunks do not cover the stored content");
  return content;
}

export interface SourceAcquisition {
  schema: "dsh-sci.source-acquisition.v1";
  acquisitionId: string;
  projectId: string;
  kind: "reference" | "document";
  origin: string;
  startedAt: string;
  finishedAt?: string;
  status: "pending" | "available" | "metadata-only" | "unreadable" | "restricted" | "not-found" | "failed";
  sourceId?: string;
  contentVersionId?: string;
  failureKind?: string;
}

export function summarizeSourceContent(content: SourceContentVersion): SourceContentSummary {
  const { text, chunks, ...summary } = content;
  return { ...summary, characters: text.length, chunkCount: chunks.length, chunkIndex: chunks.map(({ text: _text, ...chunk }) => chunk) };
}

export function describeSourceContent(content: SourceContentVersion): Omit<SourceContentSummary, "chunkIndex"> {
  const { chunkIndex: _index, ...summary } = summarizeSourceContent(content);
  return summary;
}

export interface SourceReadInput { sourceId: string; contentVersionId?: string; offset?: number; limit?: number; }
export function sourceReadRange(input: SourceReadInput, content: SourceContentVersion): { chunks: SourceContentChunk[]; nextOffset?: number } {
  const offset = input.offset ?? 0, limit = input.limit ?? 2;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= content.chunks.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 3) throw new Error("Source read needs a valid chunk offset and a limit between 1 and 3");
  const chunks = content.chunks.slice(offset, offset + limit);
  return { chunks, ...(offset + chunks.length < content.chunks.length ? { nextOffset: offset + chunks.length } : {}) };
}

export function verifySourceCitation(citation: ResearchCitation, content?: SourceContentVersion): NonNullable<ResearchCitation["verification"]> {
  const checkedAt = new Date().toISOString();
  if (!content) return { status: "unverified", checkedAt, method: "automatic", targetExists: false, note: "No versioned source content is available. A candidate excerpt is not a verified source." };
  const base = { checkedAt, method: "automatic" as const, targetExists: true, contentHash: content.contentHash };
  const locator = citation.locator;
  if (!locator || typeof locator === "string") return { ...base, status: "unverified", locatorValid: false, note: "Use a stored chunk/page or absolute character offsets to verify the location." };
  let chunks = content.chunks;
  if (locator.chunkId) chunks = chunks.filter((chunk) => chunk.chunkId === locator.chunkId);
  if (locator.page !== undefined) chunks = chunks.filter((chunk) => chunk.page === locator.page);
  const hasOffsets = locator.startOffset !== undefined && locator.endOffset !== undefined;
  const addressable = Boolean(locator.chunkId || locator.page !== undefined || hasOffsets);
  const start = locator.startOffset ?? chunks[0]?.startOffset ?? 0;
  const end = locator.endOffset ?? chunks[chunks.length - 1]?.endOffset ?? 0;
  const invalid = !addressable || !chunks.length || Boolean(locator.section || locator.paragraph) || (locator.startOffset === undefined) !== (locator.endOffset === undefined) || start < 0 || end <= start || end > content.text.length || (hasOffsets && (start < chunks[0].startOffset || end > chunks[chunks.length - 1].endOffset));
  if (invalid) return { ...base, status: "invalid-location", locatorValid: false, quoteMatches: false, note: "The requested location cannot be resolved in this content version." };
  const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const quote = normalize(citation.quotedText ?? "");
  const quoteMatches = Boolean(quote && normalize(content.text.slice(start, end)).includes(quote));
  return { ...base, status: quoteMatches ? "verbatim-match" : quote ? "not-in-available-content" : "unverified", locatorValid: true, quoteMatches, note: quoteMatches ? "Text matches the stored location; support for a claim still requires separate review." : "Not verified in the available location; this does not establish absence from the original full text." };
}
