import { createHash, randomUUID } from "node:crypto";

export type ResearchSourceKind = "web" | "paper" | "book" | "dataset" | "code" | "conversation" | "other";
export type EvidenceRelation = "supports" | "refutes" | "qualifies" | "context";
export type ResearchReadingStatus = "discovered" | "partially-read" | "abstract-read" | "full-text-read" | "unreadable";
export type CitationVerificationStatus = "unverified" | "verbatim-match" | "not-in-available-content" | "invalid-location";

export interface ResearchSource {
  schema: "dsh-sci.research-source.v1";
  sourceId: string;
  projectId: string;
  kind: ResearchSourceKind;
  title: string;
  url?: string;
  authors: string[];
  publishedAt?: string;
  retrievedAt: string;
  locator?: string;
  excerpt?: string;
  contentHash?: string;
  metadata: Record<string, string>;
  documentId?: string;
  latestContentVersionId?: string;
  quality: {
    authority: "unknown" | "low" | "medium" | "high";
    recency: "unknown" | "stale" | "current";
    reproducibility: "unknown" | "low" | "medium" | "high";
    accessibility: "unknown" | "restricted" | "open";
    score?: number;
    notes?: string;
  };
  provenance?: { kind: "manual" | "search" | "reference" | "document"; provider?: string; query?: string; rank?: number };
  reading?: { status: ResearchReadingStatus; basis?: "abstract" | "full-text" | "ocr" | "metadata"; readAt?: string; contentHash?: string; contentVersionId?: string; note?: string };
}

export interface ResearchCitationLocator {
  page?: number;
  section?: string;
  paragraph?: number;
  chunkId?: string;
  startOffset?: number;
  endOffset?: number;
}

export interface ResearchCitation {
  schema: "dsh-sci.research-citation.v1";
  citationId: string;
  sourceId: string;
  projectId: string;
  contentVersionId?: string;
  locator?: string | ResearchCitationLocator;
  quotedText?: string;
  note?: string;
  verification?: { status: CitationVerificationStatus; checkedAt: string; method: "automatic"; targetExists?: boolean; locatorValid?: boolean; quoteMatches?: boolean; contentHash?: string; note?: string };
}

export interface ResearchClaim {
  schema: "dsh-sci.research-claim.v1";
  claimId: string;
  projectId: string;
  taskId?: string;
  text: string;
  claimType: "observation" | "interpretation" | "hypothesis" | "conclusion" | "definition";
  confidence: "low" | "medium" | "high" | "unrated";
  citationIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ResearchEvidenceLink {
  schema: "dsh-sci.research-evidence-link.v1";
  evidenceId: string;
  projectId: string;
  claimId: string;
  relation: EvidenceRelation;
  sourceId?: string;
  citationId?: string;
  artifactRef?: string;
  experimentRef?: string;
  rationale?: string;
  createdAt: string;
}

function text(value: unknown, field: string, max = 12_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${field} is too long`);
  return result;
}

function optionalText(value: unknown, field: string, max = 12_000): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return text(value, field, max);
}

function normalizeReading(value: unknown): ResearchSource["reading"] {
  if (!value || typeof value !== "object") return { status: "discovered" };
  const input = value as Partial<NonNullable<ResearchSource["reading"]>>;
  // The unfinished pre-content draft inferred reading from excerpts. Such records
  // have no version-bound receipts and must not acquire trusted reading history.
  if (!input.contentVersionId) return { status: input.status === "unreadable" ? "unreadable" : "discovered" };
  const status = ["discovered", "partially-read", "abstract-read", "full-text-read", "unreadable"].includes(String(input.status)) ? input.status as ResearchReadingStatus : "discovered";
  const basis = input.basis && ["abstract", "full-text", "ocr", "metadata"].includes(input.basis) ? input.basis : undefined;
  return { status, contentVersionId: input.contentVersionId, ...(basis ? { basis } : {}), ...(typeof input.readAt === "string" ? { readAt: input.readAt } : {}), ...(typeof input.contentHash === "string" ? { contentHash: input.contentHash } : {}), ...(typeof input.note === "string" ? { note: input.note.slice(0, 4000) } : {}) };
}

function id(value: unknown, field: string): string {
  return text(value, field, 256).replace(/[^A-Za-z0-9._:-]/gu, "-");
}

const qualityValue = { unknown: 0.25, low: 0.45, stale: 0.4, restricted: 0.5, medium: 0.7, current: 0.8, open: 0.85, high: 1 } as const;
export function researchSourceQualityScore(quality: Pick<ResearchSource["quality"], "authority" | "recency" | "reproducibility" | "accessibility">): number {
  return Number(((qualityValue[quality.authority] + qualityValue[quality.recency] + qualityValue[quality.reproducibility] + qualityValue[quality.accessibility]) / 4).toFixed(3));
}

export function sourceIdFor(projectId: string, url: string | undefined, title: string): string {
  return `source-${createHash("sha256").update(`${projectId}\0${canonicalizeUrl(url) ?? ""}\0${url ? "" : title.toLocaleLowerCase()}`).digest("hex").slice(0, 32)}`;
}

/** Normalize URL variants that refer to the same web resource. */
export function canonicalizeUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return value.trim();
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) parsed.port = "";
    parsed.hash = "";
    const tracking = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"]);
    for (const key of [...parsed.searchParams.keys()]) if (tracking.has(key.toLowerCase())) parsed.searchParams.delete(key);
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    return parsed.toString();
  } catch { return value.trim(); }
}

function normalizeLocator(value: string | ResearchCitationLocator | undefined): string | ResearchCitationLocator | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return optionalText(value, "citation.locator", 1000);
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("citation.locator must be a string or object");
  const result: ResearchCitationLocator = {};
  if (value.page !== undefined) { if (!Number.isInteger(value.page) || value.page < 1) throw new Error("citation.locator.page must be a positive integer"); result.page = value.page; }
  if (value.paragraph !== undefined) { if (!Number.isInteger(value.paragraph) || value.paragraph < 1) throw new Error("citation.locator.paragraph must be a positive integer"); result.paragraph = value.paragraph; }
  for (const key of ["section", "chunkId"] as const) if (value[key] !== undefined) result[key] = text(value[key], `citation.locator.${key}`, 1000);
  for (const key of ["startOffset", "endOffset"] as const) if (value[key] !== undefined) { if (!Number.isInteger(value[key]) || value[key] < 0) throw new Error(`citation.locator.${key} must be a non-negative integer`); result[key] = value[key]; }
  if (result.startOffset !== undefined && result.endOffset !== undefined && result.endOffset < result.startOffset) throw new Error("citation locator endOffset must be >= startOffset");
  if (!Object.keys(result).length) throw new Error("citation.locator must not be empty");
  return result;
}

/** Fill defaults for source records written by pre-quality metadata versions. */
export function normalizeResearchSource(source: ResearchSource): ResearchSource {
  const legacy = source as ResearchSource & { quality?: Partial<ResearchSource["quality"]> };
  return {
    ...source,
    url: canonicalizeUrl(source.url),
    metadata: source.metadata && typeof source.metadata === "object" ? source.metadata : {},
    authors: Array.isArray(source.authors) ? source.authors : [],
    quality: {
      authority: ["unknown", "low", "medium", "high"].includes(String(legacy.quality?.authority)) ? legacy.quality!.authority as ResearchSource["quality"]["authority"] : "unknown",
      recency: ["unknown", "stale", "current"].includes(String(legacy.quality?.recency)) ? legacy.quality!.recency as ResearchSource["quality"]["recency"] : "unknown",
      reproducibility: ["unknown", "low", "medium", "high"].includes(String(legacy.quality?.reproducibility)) ? legacy.quality!.reproducibility as ResearchSource["quality"]["reproducibility"] : "unknown",
      accessibility: ["unknown", "restricted", "open"].includes(String(legacy.quality?.accessibility)) ? legacy.quality!.accessibility as ResearchSource["quality"]["accessibility"] : "unknown",
      score: typeof legacy.quality?.score === "number" && Number.isFinite(legacy.quality.score) ? Math.max(0, Math.min(1, legacy.quality.score)) : researchSourceQualityScore({ authority: ["unknown", "low", "medium", "high"].includes(String(legacy.quality?.authority)) ? legacy.quality!.authority as ResearchSource["quality"]["authority"] : "unknown", recency: ["unknown", "stale", "current"].includes(String(legacy.quality?.recency)) ? legacy.quality!.recency as ResearchSource["quality"]["recency"] : "unknown", reproducibility: ["unknown", "low", "medium", "high"].includes(String(legacy.quality?.reproducibility)) ? legacy.quality!.reproducibility as ResearchSource["quality"]["reproducibility"] : "unknown", accessibility: ["unknown", "restricted", "open"].includes(String(legacy.quality?.accessibility)) ? legacy.quality!.accessibility as ResearchSource["quality"]["accessibility"] : "unknown" }),
      notes: typeof legacy.quality?.notes === "string" ? legacy.quality.notes : undefined,
    },
    reading: normalizeReading(source.reading),
  };
}

export function makeResearchSource(projectId: string, input: Partial<Omit<ResearchSource, "schema" | "sourceId" | "projectId" | "retrievedAt">> & { title: string }, now = new Date().toISOString()): ResearchSource {
  const title = text(input.title, "source.title", 1000);
  const url = optionalText(input.url, "source.url", 4000);
  const authors = Array.isArray(input.authors) ? input.authors.map((value, index) => text(value, `source.authors[${index}]`, 500)).slice(0, 100) : [];
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.metadata ?? {}).slice(0, 100)) if (/^[A-Za-z0-9._:-]{1,128}$/u.test(key) && typeof value === "string") metadata[key] = value.slice(0, 4000);
  const qualityInput = (input.quality ?? {}) as Partial<ResearchSource["quality"]>;
  const authority = ["unknown", "low", "medium", "high"].includes(String(qualityInput.authority)) ? qualityInput.authority as ResearchSource["quality"]["authority"] : "unknown";
  const recency = ["unknown", "stale", "current"].includes(String(qualityInput.recency)) ? qualityInput.recency as ResearchSource["quality"]["recency"] : "unknown";
  const reproducibility = ["unknown", "low", "medium", "high"].includes(String(qualityInput.reproducibility)) ? qualityInput.reproducibility as ResearchSource["quality"]["reproducibility"] : "unknown";
  const accessibility = ["unknown", "restricted", "open"].includes(String(qualityInput.accessibility)) ? qualityInput.accessibility as ResearchSource["quality"]["accessibility"] : "unknown";
  const excerpt = optionalText(input.excerpt, "source.excerpt", 20_000);
  // All candidates start undiscovered-as-content: only kernel extraction and
  // read receipts may set version pointers or advance reading state.
  const reading: NonNullable<ResearchSource["reading"]> = { status: "discovered" };
  return { schema: "dsh-sci.research-source.v1", sourceId: sourceIdFor(projectId, url, title), projectId, kind: input.kind ?? "other", title, url: canonicalizeUrl(url), authors, publishedAt: optionalText(input.publishedAt, "source.publishedAt", 128), retrievedAt: now, locator: optionalText(input.locator, "source.locator", 1000), excerpt, contentHash: optionalText(input.contentHash, "source.contentHash", 256), documentId: input.documentId ? id(input.documentId, "source.documentId") : undefined, metadata, quality: { authority, recency, reproducibility, accessibility, score: researchSourceQualityScore({ authority, recency, reproducibility, accessibility }), notes: optionalText(qualityInput.notes, "source.quality.notes", 4000) }, reading };
}

export function makeCitation(projectId: string, sourceId: string, input: { contentVersionId?: string; locator?: string | ResearchCitationLocator; quotedText?: string; note?: string }, citationId = randomUUID()): ResearchCitation {
  return { schema: "dsh-sci.research-citation.v1", citationId: id(citationId, "citationId"), sourceId: id(sourceId, "sourceId"), projectId, contentVersionId: input.contentVersionId ? id(input.contentVersionId, "citation.contentVersionId") : undefined, locator: normalizeLocator(input.locator), quotedText: optionalText(input.quotedText, "citation.quotedText", 20_000), note: optionalText(input.note, "citation.note", 4000), verification: { status: "unverified", checkedAt: new Date().toISOString(), method: "automatic" } };
}

export function makeClaim(projectId: string, input: { text: string; taskId?: string; claimType?: ResearchClaim["claimType"]; confidence?: ResearchClaim["confidence"]; citationIds?: string[] }, now = new Date().toISOString(), claimId = randomUUID()): ResearchClaim {
  const claim = { schema: "dsh-sci.research-claim.v1" as const, claimId: id(claimId, "claimId"), projectId, taskId: input.taskId ? id(input.taskId, "taskId") : undefined, text: text(input.text, "claim.text"), claimType: input.claimType ?? "observation", confidence: input.confidence ?? "unrated", citationIds: [...new Set((input.citationIds ?? []).map((value) => id(value, "citationId")))], createdAt: now, updatedAt: now };
  return claim;
}

export function makeEvidenceLink(projectId: string, input: { claimId: string; relation: EvidenceRelation; sourceId?: string; citationId?: string; artifactRef?: string; experimentRef?: string; rationale?: string }, now = new Date().toISOString(), evidenceId = randomUUID()): ResearchEvidenceLink {
  if (!input.sourceId && !input.artifactRef && !input.experimentRef) throw new Error("evidence link requires a source, artifact, or experiment reference");
  return { schema: "dsh-sci.research-evidence-link.v1", evidenceId: id(evidenceId, "evidenceId"), projectId, claimId: id(input.claimId, "claimId"), relation: input.relation, sourceId: input.sourceId ? id(input.sourceId, "sourceId") : undefined, citationId: input.citationId ? id(input.citationId, "citationId") : undefined, artifactRef: optionalText(input.artifactRef, "evidence.artifactRef", 1000), experimentRef: optionalText(input.experimentRef, "evidence.experimentRef", 1000), rationale: optionalText(input.rationale, "evidence.rationale", 8000), createdAt: now };
}
