import { contentDigest } from "./content-digest.js";
import { localMemoryVector, validateMemoryVector, type MemoryEmbedder, type MemoryIndexVersion, type ResearchMemoryEntry } from "./memory.js";

const algorithmVersion = "memory-zh-ngrams-v2";
export function memoryCorpusHash(entries: ResearchMemoryEntry[]): string { return contentDigest(entries); }
function payload(index: MemoryIndexVersion) {
  const { indexId: _id, contentHash: _hash, builtAt: _at, ...value } = index;
  return value;
}
export function validateMemoryIndex(index: MemoryIndexVersion): MemoryIndexVersion {
  if (!index || !["dsh-sci.research-memory-index.v1", "dsh-sci.research-memory-index.v2"].includes(index.schema) || !index.indexId || !Array.isArray(index.entryIds) || !Number.isSafeInteger(index.dimensions) || index.dimensions < 2 || index.dimensions > 4096) throw new Error("Invalid research memory index");
  if (index.schema === "dsh-sci.research-memory-index.v1") return index;
  if (!Array.isArray(index.entries) || index.entries.length !== index.entryIds.length || new Set(index.entryIds).size !== index.entryIds.length || index.entries.some((entry, i) => entry.memoryId !== index.entryIds[i] || (index.scopeProjectId !== undefined && entry.projectId !== index.scopeProjectId) || validateMemoryVector(entry.vector).length !== index.dimensions || entry.embedding?.provider !== index.provider || entry.embedding.model !== index.model || entry.embedding.version !== index.embeddingVersion || entry.embedding.dimensions !== index.dimensions) || contentDigest(payload(index)) !== index.contentHash || index.indexId !== `memory-index-${index.contentHash}`) throw new Error("Research memory index content hash or binding mismatch");
  return index;
}

/** Build embeddings into a new immutable snapshot; source entries and old indexes survive failure. */
export async function buildMemoryIndex(entries: ResearchMemoryEntry[], options: { projectId?: string; embedder?: MemoryEmbedder; expectedDimensions?: number; previous?: MemoryIndexVersion[]; force?: boolean; signal?: AbortSignal } = {}): Promise<MemoryIndexVersion> {
  const scoped = entries.filter((entry) => options.projectId === undefined || entry.projectId === options.projectId).sort((a, b) => a.memoryId.localeCompare(b.memoryId));
  const provider = options.embedder?.provider ?? "local-hash", model = options.embedder?.model ?? "sha256-token-64", embeddingVersion = options.embedder?.version ?? (options.embedder ? undefined : algorithmVersion);
  const corpusHash = memoryCorpusHash(scoped);
  const previous = (options.previous ?? []).filter((index) => index.schema === "dsh-sci.research-memory-index.v2" && index.provider === provider && index.model === model && index.embeddingVersion === embeddingVersion && index.algorithmVersion === algorithmVersion && index.scopeProjectId === options.projectId && (options.expectedDimensions === undefined || index.dimensions === options.expectedDimensions)).map(validateMemoryIndex);
  if (!options.force) {
    const exact = previous.find((index) => index.corpusHash === corpusHash);
    if (exact) return exact;
  }
  let dimensions = options.expectedDimensions;
  const indexed: ResearchMemoryEntry[] = [];
  for (const entry of scoped) {
    options.signal?.throwIfAborted();
    const cached = previous.flatMap((index) => index.entries ?? []).find((old) => old.memoryId === entry.memoryId && old.text === entry.text && (dimensions === undefined || old.vector.length === dimensions));
    const compatible = entry.embedding?.provider === provider && entry.embedding.model === model && entry.embedding.version === embeddingVersion && entry.embedding.dimensions === entry.vector.length && (dimensions === undefined || entry.vector.length === dimensions);
    const vector = !options.embedder ? localMemoryVector(entry.text) : !options.force && cached ? [...cached.vector] : !options.force && compatible ? [...entry.vector] : validateMemoryVector(await options.embedder.embed(entry.text, options.signal));
    validateMemoryVector(vector);
    dimensions ??= vector.length;
    if (vector.length !== dimensions) throw new Error("memory embedding dimensions changed during index rebuild; nothing was published");
    indexed.push({ ...structuredClone(entry), vector, embedding: { provider, model, ...(embeddingVersion ? { version: embeddingVersion } : {}), dimensions } });
  }
  if (dimensions === undefined && options.embedder) dimensions = validateMemoryVector(await options.embedder.embed("research memory index", options.signal)).length;
  dimensions ??= 64;
  const value = { schema: "dsh-sci.research-memory-index.v2" as const, ...(options.projectId ? { scopeProjectId: options.projectId } : {}), provider, model, dimensions, ...(embeddingVersion ? { embeddingVersion } : {}), algorithmVersion, corpusHash, entryIds: indexed.map((entry) => entry.memoryId), entries: indexed };
  const contentHash = contentDigest(value);
  return validateMemoryIndex({ ...value, contentHash, indexId: `memory-index-${contentHash}`, builtAt: new Date().toISOString() });
}
