import { contentDigest } from "./content-digest.js";
import type { ResearchRepository } from "./repository.js";
import type { MemorySourceBinding } from "./memory.js";

export function memoryReferenceBindings(snapshot: Awaited<ReturnType<ResearchRepository["exportProject"]>>, refs: string[]): MemorySourceBinding[] {
  return refs.map((refId) => {
    const source = snapshot.sources.find((item) => item.sourceId === refId), citation = snapshot.citations.find((item) => item.citationId === refId);
    const version = citation?.contentVersionId ?? source?.latestContentVersionId;
    const content = snapshot.sourceContents.find((item) => item.contentVersionId === version);
    if (source || citation) return { refId, kind: source ? "source" : "citation", ...(content ? { contentHash: citation ? contentDigest({ citation, contentHash: content.contentHash }) : content.contentHash, contentVersionId: content.contentVersionId } : {}) };
    const collections = [ ["claim", snapshot.claims, "claimId"], ["run", snapshot.experimentRuns, "runId"], ["artifact", snapshot.artifacts, "artifactId"], ["evaluation", snapshot.evaluations, "evaluationId"], ["report", snapshot.reports, "reportId"] ] as const;
    for (const [kind, records, idKey] of collections) {
      const record = records.find((item) => (item as unknown as Record<string, unknown>)[idKey] === refId);
      if (record) return { refId, kind, contentHash: contentDigest(record) };
    }
    return { refId, kind: "unresolved" };
  });
}
