import { createHash } from "node:crypto";
import { makeResearchSource, type ResearchSource } from "./evidence.js";
import type { SearchProvider, SearchResult } from "../services.js";

export interface ResolvedResearchReference {
  source: ResearchSource;
  abstract?: string;
  contentHash?: string;
  content?: { text: string; scope: "abstract" | "full-text"; extraction: "text"; truncated: boolean; originalHash?: string };
}

export interface ResearchReferenceFetchOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: string;
}

export class SourceAccessError extends Error {
  constructor(readonly status: number) { super(`Source request failed with HTTP ${status}`); this.name = "SourceAccessError"; }
}

export class SourceAccessChallengeError extends Error {
  constructor() {
    super("Source returned an access challenge instead of readable research content; use a permitted accessible version.");
    this.name = "SourceAccessChallengeError";
  }
}

/** Public bibliographic discovery; it is not a full web or full-text index. */
export class CrossrefSearchProvider implements SearchProvider {
  readonly provider = "crossref-public";
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}
  async search(query: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<{ provider: string; results: SearchResult[] }> {
    if (!query.trim() || query.length > 1000) throw new Error("Bibliographic query must contain 1 to 1000 characters");
    const rows = Math.max(1, Math.min(10, Math.floor(options.limit ?? 10)));
    const endpoint = new URL("https://api.crossref.org/works");
    endpoint.searchParams.set("query.bibliographic", query.trim());
    endpoint.searchParams.set("rows", String(rows));
    endpoint.searchParams.set("select", "DOI,title,abstract,URL");
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
    const payload = await json(this.fetchImpl, endpoint.toString(), signal);
    if (!Array.isArray(payload?.message?.items)) throw new Error("Bibliographic provider returned invalid results");
    const results: SearchResult[] = [];
    for (const item of payload.message.items.slice(0, rows)) {
      const title = clean(Array.isArray(item.title) ? item.title[0] : item.title, 1000);
      const doi = typeof item.DOI === "string" ? doiFrom(item.DOI) : undefined;
      if (title && doi) results.push({ title, url: `https://doi.org/${doi}`, snippet: typeof item.abstract === "string" ? clean(stripMarkup(item.abstract), 1000) : undefined, source: this.provider });
    }
    return { provider: this.provider, results };
  }
}

function clean(value: unknown, max = 20_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.replace(/\s+/gu, " ").trim();
  return result ? result.slice(0, max) : undefined;
}

function doiFrom(value: string): string | undefined {
  const normalized = value.trim().replace(/^doi:\s*/iu, "");
  const match = normalized.match(/^(?:https?:\/\/)?(?:dx\.)?doi\.org\//iu);
  const doi = (match ? normalized.replace(match[0], "") : normalized).replace(/[)\].,;]+$/gu, "");
  return /^10\.\d{4,9}\/[\S]+$/u.test(doi) ? doi : undefined;
}

function arxivFrom(value: string): string | undefined {
  const match = value.trim().match(/(?:arxiv\.org\/(?:abs|pdf)\/|^arxiv:)([0-9]{4}\.\d{4,5}(?:v\d+)?|[a-z-]+\/[0-9]{7}(?:v\d+)?)/iu);
  return match?.[1];
}

function stripMarkup(value: string): string { return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ").replace(/<[^>]+>/gu, " ").replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/\s+/gu, " ").trim(); }
async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error("Reference response exceeds 8 MiB");
      parts.push(result.value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(parts).toString("utf8");
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function isoDate(value: unknown): string | undefined { const date = Array.isArray(value) ? value.join("-") : typeof value === "string" ? value : undefined; return date && /^\d{4}(?:-\d{2})?(?:-\d{2})?$/u.test(date) ? date : undefined; }

async function json(fetchImpl: typeof fetch, url: string, signal?: AbortSignal): Promise<any> {
  const response = await fetchImpl(url, { headers: { accept: "application/json, application/xml, text/xml" }, signal });
  if (!response.ok) throw new SourceAccessError(response.status);
  return JSON.parse(await boundedText(response));
}

async function resolveCrossref(projectId: string, doi: string, options: ResearchReferenceFetchOptions): Promise<ResolvedResearchReference> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const payload = await json(fetchImpl, `https://api.crossref.org/works/${encodeURIComponent(doi)}`, options.signal);
  const message = payload?.message ?? {};
  const title = clean(Array.isArray(message.title) ? message.title[0] : message.title) ?? doi;
  const authors = Array.isArray(message.author) ? message.author.map((author: any) => [author.given, author.family].filter(Boolean).join(" ")).filter(Boolean).slice(0, 100) : [];
  const published = message.published?.["date-parts"]?.[0];
  const abstract = clean(typeof message.abstract === "string" ? stripMarkup(message.abstract) : undefined, 200_001);
  return { source: makeResearchSource(projectId, { kind: "paper", title, url: `https://doi.org/${doi}`, authors, publishedAt: isoDate(published), excerpt: abstract?.slice(0, 20_000), metadata: { doi, provider: "crossref", ...(typeof message.publisher === "string" ? { publisher: message.publisher } : {}) }, quality: { authority: "high", recency: "current", reproducibility: "unknown", accessibility: "open", notes: "Metadata resolved from Crossref; verify the paper before treating claims as evidence." } }), abstract, contentHash: abstract ? hash(abstract) : undefined, ...(abstract ? { content: { text: abstract, scope: "abstract", extraction: "text", truncated: abstract.length > 200_000 } } : {}) };
}

async function resolveArxiv(projectId: string, arxivId: string, options: ResearchReferenceFetchOptions): Promise<ResolvedResearchReference> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`, { headers: { accept: "application/atom+xml, application/xml, text/xml" }, signal: options.signal });
  if (!response.ok) throw new SourceAccessError(response.status);
  const xml = await boundedText(response);
  const entry = /<entry>([\s\S]*?)<\/entry>/iu.exec(xml)?.[1] ?? "";
  const value = (tag: string) => clean(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "iu").exec(entry)?.[1], tag === "summary" ? 200_001 : 1000);
  const title = value("title") ?? arxivId;
  const abstract = value("summary");
  const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/giu)].map((match) => clean(match[1])!).filter(Boolean).slice(0, 100);
  return { source: makeResearchSource(projectId, { kind: "paper", title, url: `https://arxiv.org/abs/${arxivId}`, authors, publishedAt: value("published")?.slice(0, 10), excerpt: abstract?.slice(0, 20_000), metadata: { arxivId, provider: "arxiv" }, quality: { authority: "medium", recency: "current", reproducibility: "unknown", accessibility: "open", notes: "arXiv metadata and abstract; peer review status should be checked separately." } }), abstract, contentHash: abstract ? hash(abstract) : undefined, ...(abstract ? { content: { text: abstract, scope: "abstract", extraction: "text", truncated: abstract.length > 200_000 } } : {}) };
}

async function resolveWeb(projectId: string, url: string, options: ResearchReferenceFetchOptions): Promise<ResolvedResearchReference> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, { headers: { accept: "text/html, text/plain" }, signal: options.signal });
  if (!response.ok) throw new SourceAccessError(response.status);
  const raw = await boundedText(response);
  const type = response.headers.get("content-type") ?? "text/html";
  if (!/^(?:text\/|application\/xhtml\+xml)/iu.test(type)) throw new Error("Reference is not a supported text page; ingest PDF documents separately");
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/iu.exec(raw)?.[1]) ?? url;
  const extracted = type.startsWith("text/plain") ? raw : stripMarkup(raw);
  // HTTP 200 is also used by browser checks. A challenge is not a paper body.
  // Match explicit challenge titles/headers, not incidental CAPTCHA mentions or
  // widgets in otherwise readable articles. Other access walls still need review.
  const challengeTitle = /^(?:checking your browser(?:\s*[-–—|:]\s*(?:recaptcha|cloudflare))?|just a moment[.!…]*|attention required!?\s*\|\s*cloudflare|robot check|verify (?:that )?you are (?:a )?human|human verification|captcha verification)$/iu.test(title.trim());
  const shortBrowserCheck = extracted.length < 3000 && /^checking your browser(?:\s*[-–—|:]\s*recaptcha)?\s+checking your browser before accessing\b/iu.test(extracted);
  if (response.headers.get("cf-mitigated")?.toLowerCase() === "challenge" || challengeTitle || shortBrowserCheck) throw new SourceAccessChallengeError();
  const excerpt = clean(extracted, 20_000);
  return { source: makeResearchSource(projectId, { kind: "web", title, url, excerpt, contentHash: hash(raw), metadata: { provider: "open-web" }, quality: { authority: "unknown", recency: "current", reproducibility: "unknown", accessibility: "open", notes: "Open web content requires source review before use as an authoritative claim." } }), contentHash: hash(raw), ...(extracted.trim() ? { content: { text: extracted, scope: "full-text", extraction: "text", truncated: extracted.length > 200_000, originalHash: hash(raw) } } : {}) };
}

/** Resolve DOI, arXiv, Crossref metadata URLs, or ordinary web pages into stable source records. */
export async function resolveResearchReference(projectId: string, reference: string, options: ResearchReferenceFetchOptions = {}): Promise<ResolvedResearchReference> {
  options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) };
  const value = reference.trim();
  if (!value) throw new Error("research reference is required");
  const doi = doiFrom(value);
  if (doi) return resolveCrossref(projectId, doi, options);
  const arxivId = arxivFrom(value);
  if (arxivId) return resolveArxiv(projectId, arxivId, options);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("research reference must be a DOI, arXiv identifier, or URL"); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("research reference URL must use HTTP or HTTPS");
  if (url.hostname.toLowerCase() === "api.crossref.org" && /\/works\//u.test(url.pathname)) return resolveCrossref(projectId, decodeURIComponent(url.pathname.split("/works/")[1]), options);
  return resolveWeb(projectId, url.toString(), options);
}
