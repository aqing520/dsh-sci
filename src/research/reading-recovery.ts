import type { ResearchTask } from "./domain.js";
import type { ResearchRepository } from "./repository.js";

type Snapshot = Awaited<ReturnType<ResearchRepository["exportProject"]>>;

/** Metadata for an interrupted reading task, never a substitute for reading.
 * Keep old content versions and exact chunk indexes; the latest source pointer
 * may have changed after the citation was created. */
export function readingRecoveryContext(snapshot: Snapshot, task: ResearchTask) {
  const candidates = snapshot.citations.filter((citation) => {
    const check = citation.verification;
    return check?.targetExists && check.locatorValid && check.quoteMatches;
  });
  const citations = candidates.slice(0, 12).flatMap((citation) => {
    const content = snapshot.sourceContents.find((item) => item.contentVersionId === citation.contentVersionId && item.sourceId === citation.sourceId);
    const locator = citation.locator;
    if (!content || !locator || typeof locator === "string" || citation.verification?.contentHash !== content.contentHash) return [];
    const chunks = content.chunkIndex.filter((chunk) => (!locator.chunkId || chunk.chunkId === locator.chunkId) && (locator.page === undefined || chunk.page === locator.page) && (locator.startOffset === undefined || chunk.endOffset > locator.startOffset) && (locator.endOffset === undefined || chunk.startOffset < locator.endOffset));
    if (!chunks.length) return [];
    const read = new Set(snapshot.sourceReads.filter((receipt) => receipt.audience === "agent" && receipt.planId === task.planId && receipt.taskId === task.taskId && receipt.attemptId === task.attemptId && receipt.contentVersionId === content.contentVersionId && receipt.contentHash === content.contentHash).flatMap((receipt) => receipt.chunkIds));
    return [{ citationId: citation.citationId, sourceId: citation.sourceId, contentVersionId: content.contentVersionId,
      // No quote or body is injected. Only the tool call can create a receipt.
      requiredReads: chunks.filter((chunk) => !read.has(chunk.chunkId)).slice(0, 12).map((chunk) => ({ action: "source-read", sourceId: citation.sourceId, contentVersionId: content.contentVersionId, offset: chunk.index, limit: 1 })),
      citedChunks: chunks.length, omittedChunks: Math.max(0, chunks.filter((chunk) => !read.has(chunk.chunkId)).length - 12),
    }];
  });
  return { scope: "Saved citation locations only; not evidence of a current-attempt read, source independence or claim support. Execute requiredReads before reusing these citations; inspect omitted records if needed.", citations, omittedCitations: Math.max(0, candidates.length - 12) };
}
