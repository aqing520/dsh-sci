import { createHash, randomUUID } from "node:crypto";

export interface ResearchMemoryEntry {
  schema: "dsh-sci.research-memory.v1";
  memoryId: string;
  projectId?: string;
  kind: "question" | "source" | "claim" | "experiment" | "report" | "note";
  text: string;
  refs: string[];
  createdAt: string;
  updatedAt: string;
  vector: number[];
  embedding?: { provider: string; model: string; version?: string; dimensions: number };
  applicability?: string;
  sourceBindings?: MemorySourceBinding[];
  confidence: "low" | "medium" | "high" | "unrated";
  expiresAt?: string;
  conflictKey?: string;
  conflictIds: string[];
  supersedes?: string[];
  review?: ResearchMemoryReview;
}

export interface MemorySearchResult { entry: ResearchMemoryEntry; score: number; warnings: string[]; }
export interface MemorySourceBinding { refId: string; kind: "source" | "citation" | "claim" | "run" | "artifact" | "evaluation" | "report" | "unresolved"; contentHash?: string; contentVersionId?: string; }
export interface MemorySearchOptions { limit?: number; projectId?: string; minScore?: number; since?: string; until?: string; minConfidence?: ResearchMemoryEntry["confidence"]; rewrittenQuery?: string; }
export type ResearchMemoryReviewStatus = "unresolved" | "accepted" | "superseded" | "ignored";
export interface ResearchMemoryReview { status: ResearchMemoryReviewStatus; reviewedAt: string; note?: string; selectedMemoryId?: string; }
export interface MemoryConflictGroup { conflictKey: string; entries: ResearchMemoryEntry[]; reviewStatus: ResearchMemoryReviewStatus; }
export interface MemoryEmbedder { readonly provider: string; readonly model: string; readonly version?: string; embed(text: string, signal?: AbortSignal): Promise<number[]>; }
export interface MemoryIndexVersion {
  schema: "dsh-sci.research-memory-index.v1" | "dsh-sci.research-memory-index.v2";
  indexId: string;
  scopeProjectId?: string;
  provider: string;
  model: string;
  dimensions: number;
  entryIds: string[];
  contentHash: string;
  builtAt: string;
  embeddingVersion?: string;
  algorithmVersion?: string;
  corpusHash?: string;
  /** Immutable search snapshot. V1 only stored IDs and is never used for V2 retrieval. */
  entries?: ResearchMemoryEntry[];
}
export interface MemoryRetrievalRecord {
  schema: "dsh-sci.research-memory-retrieval.v1";
  retrievalId: string;
  projectId?: string;
  query: string;
  rewrittenQuery?: string;
  indexId: string;
  provider: string;
  model: string;
  dimensions: number;
  memoryIds: string[];
  createdAt: string;
  entryBindings?: Array<{ memoryId: string; contentHash: string }>;
  filters?: MemorySearchOptions;
  purpose?: "search" | "task-context";
  planId?: string;
  taskId?: string;
  attemptId?: string;
  injectedMemoryIds?: string[];
  injectedMemories?: Array<{ memoryId: string; text: string; applicability?: string; refs: string[]; sourceBindings?: MemorySourceBinding[]; warnings: string[] }>;
}

export function validateMemorySearchOptions(options: MemorySearchOptions): void {
  for (const field of ["since", "until"] as const) {
    const value = options[field];
    if (value !== undefined && (typeof value !== "string" || !Number.isFinite(Date.parse(value)))) throw new Error(`memory search ${field} must be a date string`);
  }
  if (options.since !== undefined && options.until !== undefined && Date.parse(options.since) > Date.parse(options.until)) throw new Error("memory search since must be before until");
  if (options.minConfidence !== undefined && !["unrated", "low", "medium", "high"].includes(options.minConfidence)) throw new Error("memory search minConfidence is invalid");
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100)) throw new Error("memory search limit must be an integer from 1 to 100");
  if (options.minScore !== undefined && !Number.isFinite(options.minScore)) throw new Error("memory search minScore must be finite");
  if (options.rewrittenQuery !== undefined && (typeof options.rewrittenQuery !== "string" || options.rewrittenQuery.trim().length > 4000)) throw new Error("memory search rewrittenQuery must be a string up to 4000 characters");
}

export function rewriteMemoryQuery(query: string): string {
  return query.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 4000);
}

function tokens(value: string): string[] {
  const text = value.toLowerCase().normalize("NFKC");
  const result: string[] = text.match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const run of text.match(/\p{Script=Han}+/gu) ?? []) {
    const chars = [...run];
    result.push(...chars);
    for (let index = 0; index + 1 < chars.length; index++) result.push(chars[index] + chars[index + 1]);
  }
  return [...new Set(result)];
}
export function localMemoryVector(value: string, dimensions = 64): number[] {
  const result = Array.from({ length: dimensions }, () => 0);
  for (const token of tokens(value)) { const digest = createHash("sha256").update(token).digest(); const index = digest.readUInt32BE(0) % dimensions; result[index] += digest[4] % 2 ? 1 : -1; }
  const norm = Math.hypot(...result) || 1;
  return result.map((item) => item / norm);
}
export function validateMemoryVector(value: number[]): number[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4096 || value.some((item) => typeof item !== "number" || !Number.isFinite(item)) || !value.some((item) => item !== 0)) throw new Error("memory embedder returned an invalid vector");
  return value;
}
function cosine(a: number[], b: number[]): number { const norm = Math.hypot(...a) * Math.hypot(...b); return a.length === b.length && norm ? a.reduce((sum, value, index) => sum + value * b[index], 0) / norm : 0; }
function normalized(value: string): string { return value.toLocaleLowerCase().normalize("NFKC").replace(/\s+/gu, " ").trim(); }
function active(entry: ResearchMemoryEntry, now = new Date()): boolean { return entry.review?.status !== "superseded" && entry.review?.status !== "ignored" && (!entry.expiresAt || Date.parse(entry.expiresAt) > now.getTime()); }
function confidenceRank(value: ResearchMemoryEntry["confidence"]): number { return value === "high" ? 3 : value === "medium" ? 2 : value === "low" ? 1 : 0; }
function inRange(entry: ResearchMemoryEntry, options: MemorySearchOptions): boolean {
  const timestamp = Date.parse(entry.updatedAt);
  if ((options.since !== undefined || options.until !== undefined) && !Number.isFinite(timestamp)) return false;
  if (options.since !== undefined) { const since = Date.parse(options.since); if (Number.isNaN(since) || timestamp < since) return false; }
  if (options.until !== undefined) { const until = Date.parse(options.until); if (Number.isNaN(until) || timestamp > until) return false; }
  return options.minConfidence === undefined || confidenceRank(entry.confidence) >= confidenceRank(options.minConfidence);
}

export function normalizeResearchMemory(entry: ResearchMemoryEntry): ResearchMemoryEntry {
  const legacy = entry as ResearchMemoryEntry & { confidence?: unknown };
  const review = entry.review && typeof entry.review === "object" && ["unresolved", "accepted", "superseded", "ignored"].includes(String(entry.review.status)) ? { status: entry.review.status, reviewedAt: typeof entry.review.reviewedAt === "string" ? entry.review.reviewedAt : new Date(0).toISOString(), ...(typeof entry.review.note === "string" ? { note: entry.review.note.slice(0, 4000) } : {}), ...(typeof entry.review.selectedMemoryId === "string" ? { selectedMemoryId: entry.review.selectedMemoryId } : {}) } : undefined;
  return { ...entry, refs: Array.isArray(entry.refs) ? entry.refs : [], vector: Array.isArray(entry.vector) ? entry.vector : localMemoryVector(entry.text), confidence: ["low", "medium", "high", "unrated"].includes(String(legacy.confidence)) ? legacy.confidence as ResearchMemoryEntry["confidence"] : "unrated", conflictIds: Array.isArray(entry.conflictIds) ? entry.conflictIds : [], ...(review ? { review } : {}) };
}

export class ResearchMemoryStore {
  constructor(private readonly entries: ResearchMemoryEntry[] = [], private readonly options: { embedder?: MemoryEmbedder } = {}) { for (let index = 0; index < entries.length; index += 1) entries[index] = normalizeResearchMemory(entries[index]); }
  add(input: { text: string; kind: ResearchMemoryEntry["kind"]; projectId?: string; refs?: string[]; memoryId?: string; confidence?: ResearchMemoryEntry["confidence"]; expiresAt?: string; conflictKey?: string; supersedes?: string[]; applicability?: string; sourceBindings?: MemorySourceBinding[] }, now = new Date().toISOString()): ResearchMemoryEntry {
    if (typeof input.text !== "string" || !input.text.trim()) throw new Error("memory text is required");
    if (input.conflictKey !== undefined && (typeof input.conflictKey !== "string" || !input.conflictKey.trim() || input.conflictKey.length > 256)) throw new Error("memory conflictKey must be 1 to 256 characters");
    for (const refs of [input.refs, input.supersedes]) if (refs !== undefined && (!Array.isArray(refs) || refs.length > 100 || refs.some((ref) => typeof ref !== "string" || !ref.trim() || ref.length > 256))) throw new Error("memory refs must contain up to 100 IDs of 1 to 256 characters");
    if (input.expiresAt && !Number.isFinite(Date.parse(input.expiresAt))) throw new Error("memory expiresAt must be a date string");
    if (input.applicability !== undefined && (typeof input.applicability !== "string" || input.applicability.length > 4000)) throw new Error("memory applicability must be a string up to 4000 characters");
    const textValue = input.text.trim().slice(0, 20_000);
    const duplicate = this.entries.find((entry) => entry.projectId === input.projectId && entry.kind === input.kind && normalized(entry.text) === normalized(textValue));
    if (duplicate) {
      duplicate.refs = [...new Set([...duplicate.refs, ...(input.refs ?? [])])].slice(0, 100);
      duplicate.updatedAt = now;
      if (input.confidence) duplicate.confidence = input.confidence;
      if (input.expiresAt) duplicate.expiresAt = input.expiresAt;
      if (input.applicability !== undefined) duplicate.applicability = input.applicability.trim();
      if (input.sourceBindings) duplicate.sourceBindings = [...new Map([...(duplicate.sourceBindings ?? []), ...input.sourceBindings].map((binding) => [binding.refId, binding])).values()];
      return duplicate;
    }
    const conflicts = input.conflictKey ? this.entries.filter((entry) => entry.projectId === input.projectId && entry.conflictKey === input.conflictKey && normalized(entry.text) !== normalized(textValue)) : [];
    const entry: ResearchMemoryEntry = { schema: "dsh-sci.research-memory.v1", memoryId: input.memoryId ?? randomUUID(), projectId: input.projectId, kind: input.kind, text: textValue, refs: [...new Set(input.refs ?? [])].slice(0, 100), createdAt: now, updatedAt: now, vector: localMemoryVector(textValue), confidence: input.confidence ?? "unrated", expiresAt: input.expiresAt, conflictKey: input.conflictKey, conflictIds: conflicts.map((item) => item.memoryId), supersedes: input.supersedes ? [...new Set(input.supersedes)].slice(0, 100) : undefined, ...(input.applicability ? { applicability: input.applicability.trim() } : {}) };
    if (input.sourceBindings) entry.sourceBindings = input.sourceBindings;
    for (const conflict of conflicts) { conflict.conflictIds = [...new Set([...conflict.conflictIds, entry.memoryId])].slice(0, 100); conflict.updatedAt = now; }
    this.entries.push(entry); return entry;
  }
  all(): ResearchMemoryEntry[] { return [...this.entries]; }
  conflicts(projectId?: string): MemoryConflictGroup[] {
    const groups = new Map<string, ResearchMemoryEntry[]>();
    for (const entry of this.entries) {
      if (!entry.conflictKey || (projectId !== undefined && entry.projectId !== projectId)) continue;
      const key = `${entry.projectId ?? ""}\0${entry.conflictKey}`;
      const values = groups.get(key) ?? [];
      values.push(entry);
      groups.set(key, values);
    }
    return [...groups.values()].filter((entries) => entries.some((entry) => entry.conflictIds.length > 0)).map((entries) => {
      const conflictKey = entries[0].conflictKey!;
      const ordered = entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      const statuses = new Set(ordered.map((entry) => entry.review?.status ?? "unresolved"));
      const reviewStatus = statuses.size === 1 ? [...statuses][0] : statuses.has("accepted") && [...statuses].every((status) => status === "accepted" || status === "superseded") ? "accepted" : "unresolved";
      return { conflictKey, entries: ordered, reviewStatus };
    });
  }
  reviewConflict(projectId: string, conflictKey: string, input: { status: ResearchMemoryReviewStatus; selectedMemoryId?: string; note?: string }, now = new Date().toISOString()): MemoryConflictGroup {
    if (!["unresolved", "accepted", "superseded", "ignored"].includes(String(input.status))) throw new Error("memory review status is invalid");
    const entries = this.entries.filter((entry) => entry.projectId === projectId && entry.conflictKey === conflictKey && entry.conflictIds.length > 0);
    if (!entries.length) throw new Error(`research memory conflict not found: ${conflictKey}`);
    if (input.status === "accepted") {
      if (!input.selectedMemoryId || !entries.some((entry) => entry.memoryId === input.selectedMemoryId)) throw new Error("accepted memory review requires a selectedMemoryId from the conflict");
    } else if (input.selectedMemoryId && !entries.some((entry) => entry.memoryId === input.selectedMemoryId)) throw new Error("selectedMemoryId must belong to the conflict");
    const note = typeof input.note === "string" ? input.note.trim().slice(0, 4000) : undefined;
    for (const entry of entries) {
      const status = input.status === "accepted" ? (entry.memoryId === input.selectedMemoryId ? "accepted" : "superseded") : input.status;
      entry.review = { status, reviewedAt: now, ...(note ? { note } : {}), ...(input.selectedMemoryId ? { selectedMemoryId: input.selectedMemoryId } : {}) };
      entry.updatedAt = now;
    }
    return this.conflicts(projectId).find((group) => group.conflictKey === conflictKey)!;
  }
  search(query: string, options: MemorySearchOptions = {}): MemorySearchResult[] {
    validateMemorySearchOptions(options);
    const effectiveQuery = options.rewrittenQuery?.trim() || rewriteMemoryQuery(query);
    const localEntries = this.entries.map((entry) => ({ ...entry, vector: localMemoryVector(entry.text) }));
    return new ResearchMemoryStore(localEntries).searchVector(effectiveQuery, localMemoryVector(effectiveQuery), options);
  }
  /** The caller supplies one compatible index snapshot; never compares mixed dimensions. */
  searchVector(query: string, queryVector: number[], options: MemorySearchOptions = {}): MemorySearchResult[] {
    validateMemorySearchOptions(options); validateMemoryVector(queryVector);
    const terms = new Set(tokens(query)), minScore = options.minScore ?? -1;
    const unresolvedIds = new Set(this.conflicts().filter((group) => group.reviewStatus === "unresolved").flatMap((group) => group.entries.map((entry) => entry.memoryId)));
    const superseded = new Set(this.entries.flatMap((entry) => (entry.supersedes ?? []).filter((id) => this.entries.some((old) => old.memoryId === id && old.projectId === entry.projectId))));
    return this.entries.filter((entry) => active(entry) && !superseded.has(entry.memoryId) && inRange(entry, options) && (options.projectId === undefined || entry.projectId === options.projectId)).map((entry) => {
      validateMemoryVector(entry.vector);
      if (entry.vector.length !== queryVector.length) throw new Error("memory index/query vector dimension mismatch; rebuild the index");
      const lexical = tokens(entry.text).filter((token) => terms.has(token)).length / Math.max(1, terms.size);
      const confidence = entry.confidence === "high" ? 0.03 : entry.confidence === "medium" ? 0.01 : 0;
      const warnings = ["Candidate research memory; confidence and conflict resolution do not establish scientific verification."];
      if (unresolvedIds.has(entry.memoryId)) warnings.push("Unresolved memory conflict; do not treat this as an established fact.");
      if (entry.refs.length && (!entry.sourceBindings?.length || entry.sourceBindings.some((binding) => binding.kind === "unresolved" || !binding.contentHash))) warnings.push("Some source references have no saved content binding; verify them before reuse.");
      if (entry.expiresAt) warnings.push(`Valid only before ${entry.expiresAt}.`);
      if (!entry.applicability) warnings.push("No applicability conditions recorded.");
      return { entry, score: cosine(queryVector, entry.vector) + lexical * 0.2 + confidence, warnings };
    }).filter((result) => result.score >= minScore).sort((a, b) => b.score - a.score || a.entry.memoryId.localeCompare(b.entry.memoryId)).slice(0, options.limit ?? 10);
  }
  async addAsync(input: { text: string; kind: ResearchMemoryEntry["kind"]; projectId?: string; refs?: string[]; memoryId?: string; confidence?: ResearchMemoryEntry["confidence"]; expiresAt?: string; conflictKey?: string; supersedes?: string[]; applicability?: string; sourceBindings?: MemorySourceBinding[] }, now = new Date().toISOString(), signal?: AbortSignal): Promise<ResearchMemoryEntry> {
    const entry = this.add(input, now);
    if (this.options.embedder) {
      const embedded = validateMemoryVector(await this.options.embedder.embed(entry.text, signal));
      entry.vector = embedded.slice(0, 4096);
      entry.embedding = { provider: this.options.embedder.provider, model: this.options.embedder.model, ...(this.options.embedder.version ? { version: this.options.embedder.version } : {}), dimensions: entry.vector.length };
    }
    return entry;
  }
  async searchAsync(query: string, options: MemorySearchOptions & { signal?: AbortSignal } = {}): Promise<MemorySearchResult[]> {
    validateMemorySearchOptions(options);
    if (!this.options.embedder) return this.search(query, options);
    const effectiveQuery = options.rewrittenQuery?.trim() || rewriteMemoryQuery(query), embedder = this.options.embedder;
    const embedded = validateMemoryVector(await embedder.embed(effectiveQuery, options.signal));
    const compatible = this.entries.filter((entry) => entry.embedding?.provider === embedder.provider && entry.embedding.model === embedder.model && entry.embedding.version === embedder.version && entry.embedding.dimensions === embedded.length);
    return new ResearchMemoryStore(compatible).searchVector(effectiveQuery, embedded, options);
  }
}
