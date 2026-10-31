import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ResearchRepository } from "../src/research/repository.js";
import { ResearchOrchestrator } from "../src/research/orchestrator.js";
import { normalizeResearchSource, makeResearchSource } from "../src/research/evidence.js";
import { startResearchBridge } from "../src/research/bridge.js";
import { researchInspection } from "../src/research/inspect.js";
import { taskResultIdentity } from "../src/research/task-result.js";
import { parseResearchDocument } from "../src/research/document.js";
import { CrossrefSearchProvider } from "../src/research/source-adapters.js";
import { readingRecoveryContext } from "../src/research/reading-recovery.js";
import { DshResearchTaskExecutor } from "../src/research/dsh-sdk.js";

async function fixture(run: (root: string, repository: ResearchRepository, orchestrator: ResearchOrchestrator, projectId: string) => Promise<void>, encrypted = false) {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-source-content-"));
  try {
    const repository = new ResearchRepository(path.join(root, "store"), { metadataPassphrase: encrypted ? "fixture-content-key" : undefined });
    const orchestrator = new ResearchOrchestrator(repository);
    const { project } = await orchestrator.createProject("Read before making claims", { plan: { question: "Read before making claims", tasks: [{ taskId: "read", title: "Read", kind: "source-review", objective: "Read a versioned source" }] } });
    await orchestrator.activatePlan(project.projectId);
    await orchestrator.startNextTask(project.projectId);
    await run(root, repository, orchestrator, project.projectId);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("candidate excerpts and legacy draft fields cannot fabricate reading or content versions", async () => fixture(async (_root, repository, orchestrator, projectId) => {
  const source = await orchestrator.addSource(projectId, { title: "Candidate", excerpt: "A model supplied quote", latestContentVersionId: "fake", reading: { status: "full-text-read", contentVersionId: "fake" }, provenance: { kind: "document" } });
  assert.equal(source.reading?.status, "discovered");
  assert.equal(source.latestContentVersionId, undefined);
  assert.equal(source.provenance?.kind, "manual");
  const old = makeResearchSource(projectId, { title: "Old", excerpt: "Not a reading receipt" });
  old.reading = { status: "full-text-read" };
  assert.equal(normalizeResearchSource(old).reading?.status, "discovered");
  const citation = await orchestrator.addCitation(projectId, source.sourceId, { locator: "paragraph 1", quotedText: "A model supplied quote" });
  assert.equal(citation.verification?.status, "unverified");
  await assert.rejects(orchestrator.completeTask(projectId, "read", [citation.citationId]), /missing required outputs/);
  assert.equal((await repository.listSourceReads(projectId)).length, 0);
}));

test("HTTP 200 access challenges cannot become source bodies, readings or evidence", async () => fixture(async (_root, repository, orchestrator, projectId) => {
  for (const [index, page] of [
    '<title>Checking your browser - reCAPTCHA</title><p>Checking your browser before accessing pmc.ncbi.nlm.nih.gov ...</p><p>private-challenge-diagnostic</p>',
    '<title>Just a moment...</title><p>Verify you are human.</p>',
    '<title>Attention Required! | Cloudflare</title><p>Browser verification required.</p>',
    '<title>Ordinary title</title><p>private-challenge-diagnostic</p>',
  ].entries()) {
    await assert.rejects(orchestrator.resolveReference(projectId, `https://example.test/challenge/${index}`, { fetchImpl: async () => new Response(page, { status: 200, headers: { "content-type": "text/html", ...(index === 3 ? { "cf-mitigated": "challenge" } : {}) } }) }), /access challenge/iu);
  }
  const snapshot = await repository.exportProject(projectId);
  assert.equal(snapshot.sources.length, 0);
  assert.equal(snapshot.sourceContents.length, 0);
  assert.equal(snapshot.sourceReads.length, 0);
  assert.equal(snapshot.citations.length, 0);
  assert.equal(snapshot.sourceAcquisitions.length, 4);
  for (const acquisition of snapshot.sourceAcquisitions) {
    assert.equal(acquisition.status, "restricted");
    assert.equal(acquisition.failureKind, "access-challenge", "do not invent an HTTP 403 when the server returned 200");
  }
  assert.ok(!JSON.stringify(snapshot).includes("private-challenge-diagnostic"));
}));

test("an access challenge during refresh preserves the last readable version and its citations", async () => fixture(async (_root, repository, orchestrator, projectId) => {
  const url = "https://example.test/refresh";
  const source = await orchestrator.resolveReference(projectId, url, { fetchImpl: async () => new Response('<title>Paper</title><p>Observed evidence remains intact.</p>', { headers: { "content-type": "text/html" } }) });
  const read = await orchestrator.readSource(projectId, { sourceId: source.sourceId }, "agent");
  const citation = await orchestrator.addCitation(projectId, source.sourceId, { locator: { chunkId: read.chunks[0].chunkId }, quotedText: "Observed evidence remains intact." });
  const before = await repository.exportProject(projectId);
  await assert.rejects(orchestrator.resolveReference(projectId, url, { fetchImpl: async () => new Response('<title>Checking your browser - reCAPTCHA</title><p>Checking your browser before accessing this site.</p>') }), /access challenge/iu);
  const after = await repository.exportProject(projectId);
  assert.deepEqual(after.sources, before.sources);
  assert.deepEqual(after.sourceContents, before.sourceContents);
  assert.deepEqual(after.sourceReads, before.sourceReads);
  assert.deepEqual(after.citations, before.citations);
  assert.equal(after.citations[0].citationId, citation.citationId);
  assert.equal(after.sourceAcquisitions.find((item) => item.status === "restricted")?.failureKind, "access-challenge");
}));

test("CAPTCHA research and a footer widget do not turn readable articles into access challenges", async () => fixture(async (_root, repository, orchestrator, projectId) => {
  const source = await orchestrator.resolveReference(projectId, "https://example.test/captcha-research", { fetchImpl: async () => new Response('<title>CAPTCHA research and accessibility</title><article><h1>CAPTCHA research</h1><p>We evaluate human verification interfaces and robot checks.</p></article><footer><div class="g-recaptcha">Comment form verification</div></footer>', { headers: { "content-type": "text/html" } }) });
  const content = await repository.readSourceContent(projectId, source.latestContentVersionId!);
  assert.ok(content?.text.includes("We evaluate human verification interfaces"));
  assert.equal((await repository.listSourceAcquisitions(projectId))[0].status, "available");
}));

test("read-only previews are bounded and never create receipts, mark reading or write project events", async () => fixture(async (root, repository, orchestrator, projectId) => {
  const file = path.join(root, "preview.txt");
  await writeFile(file, "Read-only preview. " + "content ".repeat(2000));
  const { source } = await orchestrator.ingestDocument(projectId, file);
  const before = await repository.exportProject(projectId);
  const reopened = new ResearchOrchestrator(new ResearchRepository(repository.root));
  const preview = await reopened.previewSource(projectId, { sourceId: source.sourceId, limit: 1 });
  assert.equal(preview.preview, true);
  assert.equal(preview.chunks.length, 1);
  assert.equal(preview.nextOffset, 1);
  assert.equal("receipt" in preview, false);
  await assert.rejects(reopened.previewSource(projectId, { sourceId: source.sourceId, limit: 4 }), /limit/u);
  assert.deepEqual(await repository.exportProject(projectId), before);
  const other = await orchestrator.addSource(projectId, { title: "Another source" });
  await assert.rejects(reopened.previewSource(projectId, { sourceId: other.sourceId, contentVersionId: source.latestContentVersionId }), /does not belong/u);
  const after = await repository.exportProject(projectId);
  assert.deepEqual(after.sourceReads, before.sourceReads);
  assert.deepEqual(await repository.readSource(projectId, source.sourceId), before.sources.find((item) => item.sourceId === source.sourceId));
  assert.deepEqual(after.events.filter((event) => event.type === "source-read"), []);
}));

test("encrypted body survives restart without copying full text into project export", async () => fixture(async (root, repository, orchestrator, projectId) => {
  const file = path.join(root, "paper.txt");
  const marker = "sensitive-research-marker";
  await writeFile(file, marker + " A".repeat(9000));
  const { source } = await orchestrator.ingestDocument(projectId, file);
  assert.equal(source.provenance?.kind, "document");
  assert.equal(source.reading?.status, "discovered");
  const versionId = source.latestContentVersionId!;
  const savedPath = path.join(repository.root, "projects", projectId, "source-content", versionId + ".json");
  assert.equal((await readFile(savedPath, "utf8")).includes(marker), false);
  const reopened = new ResearchRepository(repository.root, { metadataPassphrase: repository.metadataPassphrase });
  assert.equal((await reopened.readSourceContent(projectId, versionId))?.text.startsWith(marker), true);
  const exported = await reopened.exportProject(projectId);
  assert.equal("text" in exported.sourceContents[0], false);
  assert.equal("chunks" in exported.sourceContents[0], false);
  const reader = new ResearchOrchestrator(reopened);
  const read = await reader.readSource(projectId, { sourceId: source.sourceId, limit: 3 }, "agent");
  assert.ok(read.chunks.reduce((total, chunk) => total + chunk.text.length, 0) <= 12_000);
  assert.equal(read.nextOffset, 3);
  assert.equal("chunkIndex" in read.content, false);
  assert.equal((await reopened.readSource(projectId, source.sourceId))?.reading?.status, "partially-read");
  assert.equal((await reopened.listSourceReads(projectId))[0].attemptId, exported.plan?.tasks[0].attemptId);
  for (const limit of [0, 4, 1.5, NaN]) await assert.rejects(reader.readSource(projectId, { sourceId: source.sourceId, limit }, "agent"), /limit/);
  await assert.rejects(reader.readSource(projectId, { sourceId: source.sourceId, offset: 9999 }, "agent"), /offset/);
}, true));

test("reading gate requires the cited location in this task attempt, not a Workspace read or another chunk", async () => fixture(async (root, repository, orchestrator, projectId) => {
  const file = path.join(root, "two-chunks.txt");
  await writeFile(file, "First." + " ".repeat(3994) + "Second verified statement.");
  const { source } = await orchestrator.ingestDocument(projectId, file);
  const viewed = await orchestrator.readSource(projectId, { sourceId: source.sourceId, offset: 1, limit: 1 });
  const citation = await orchestrator.addCitation(projectId, source.sourceId, { locator: { chunkId: viewed.chunks[0].chunkId }, quotedText: "Second verified statement." });
  assert.equal(citation.verification?.status, "verbatim-match");
  await assert.rejects(orchestrator.completeTask(projectId, "read", [citation.citationId]), /missing required outputs/);
  await repository.saveSourceRead({ ...viewed.receipt, audience: "agent", readId: "old-attempt", planId: (await repository.readProject(projectId))!.planId, taskId: "read", attemptId: "expired" });
  await assert.rejects(orchestrator.completeTask(projectId, "read", [citation.citationId]), /missing required outputs/);
  await orchestrator.readSource(projectId, { sourceId: source.sourceId, offset: 0, limit: 1 }, "agent");
  await assert.rejects(orchestrator.completeTask(projectId, "read", [citation.citationId]), /missing required outputs/);
  const read = await orchestrator.readSource(projectId, { sourceId: source.sourceId, offset: 1, limit: 1 }, "agent");
  const task = (await repository.exportProject(projectId)).plan!.tasks[0];
  await repository.saveSourceRead({ ...read.receipt, readId: "wrong-attempt", attemptId: "different-attempt" });
  const result = { ...taskResultIdentity(task), projectId, taskId: task.taskId, status: "completed", summary: "Read the cited range; claim support still needs review", refs: [citation.citationId] };
  await orchestrator.submitTaskResult(projectId, result);
  assert.equal((await repository.exportProject(projectId)).plan?.tasks[0].status, "completed");
}));

test("a retried reading task reuses the exact saved citation only after rereading its old version and chunk", async () => fixture(async (_root, repository, orchestrator, projectId) => {
  const resolve = (body: string) => orchestrator.resolveReference(projectId, "https://example.test/retry", { fetchImpl: async () => new Response(`<title>Retry</title><p>${body}</p>`, { headers: { "content-type": "text/html" } }) });
  const source = await resolve("Background. ".repeat(350) + "Original retry evidence.");
  const read = await orchestrator.readSource(projectId, { sourceId: source.sourceId, offset: 1, limit: 1 }, "agent");
  const citation = await orchestrator.addCitation(projectId, source.sourceId, { contentVersionId: read.content.contentVersionId, locator: { chunkId: read.chunks[0].chunkId }, quotedText: "Original retry evidence." });
  const first = (await repository.exportProject(projectId)).plan!.tasks[0];
  await orchestrator.failTask(projectId, first.taskId, "simulated timeout after saving citation");
  await orchestrator.startNextTask(projectId);
  // A refreshed pointer must not change the recovery target.
  const refreshed = await resolve("Changed body without the cited statement.");
  assert.notEqual(refreshed.latestContentVersionId, citation.contentVersionId);
  const before = await repository.exportProject(projectId);
  const task = before.plan!.tasks[0];
  assert.notEqual(task.attemptId, first.attemptId);
  await assert.rejects(orchestrator.completeTask(projectId, task.taskId, [citation.citationId]), /missing required outputs/);
  const recovery = readingRecoveryContext(before, task);
  assert.equal(recovery.citations.length, 1);
  assert.equal(JSON.stringify(recovery).includes("Original retry evidence."), false);
  assert.deepEqual(recovery.citations[0].requiredReads, [{ action: "source-read", sourceId: source.sourceId, contentVersionId: citation.contentVersionId, offset: 1, limit: 1 }]);
  assert.equal((await repository.listSourceReads(projectId)).length, before.sourceReads.length);
  let response = "";
  const executor = new DshResearchTaskExecutor({ repository, client: {
    async initialize() {}, async createSession() {}, async resume() {}, async close() {}, async wait() {},
    async prompt(_sessionId, text) {
      const supplied = JSON.parse(text.match(/^Reading retry locations \(metadata only\): (.+)$/m)![1]);
      assert.deepEqual(supplied, recovery);
      assert.equal(text.includes("exactly three independent sources"), false);
      const { action: _action, ...request } = supplied.citations[0].requiredReads[0];
      const reread = await orchestrator.readSource(projectId, request, "agent");
      assert.equal(reread.receipt.attemptId, task.attemptId);
      assert.match(reread.chunks[0].text, /Original retry evidence/);
      response = JSON.stringify({ ...taskResultIdentity(task), projectId, taskId: task.taskId, status: "completed", summary: "Reread stored evidence; scientific support remains unreviewed", refs: [citation.citationId], claims: [], evidence: [] });
      return { messageId: "synthetic-retry-regression" };
    },
    lastAssistantText() { return response; },
  } });
  const result = await executor.execute({ project: before.project, plan: before.plan!, task });
  const after = await repository.exportProject(projectId);
  assert.deepEqual(readingRecoveryContext(after, task).citations[0].requiredReads, []);
  await orchestrator.submitTaskResult(projectId, result);
  const completed = await repository.exportProject(projectId);
  assert.equal(completed.plan!.tasks[0].status, "completed");
  assert.equal(completed.citations.length, 1);
  assert.equal(completed.experimentRuns.length, 0);
}));

test("web refresh replaces the latest pointer while old citations remain bound to the original text", async () => fixture(async (_root, repository, orchestrator, projectId) => {
  const searchSource = (await orchestrator.ingestSearchResults(projectId, "fixture search", [{ title: "Page", url: "https://example.test/paper", snippet: "Search preview only" }], "fixture-search"))[0];
  assert.equal(searchSource.reading?.status, "discovered");
  assert.equal(searchSource.provenance?.kind, "search");
  const resolve = (body: string) => orchestrator.resolveReference(projectId, "https://example.test/paper", { fetchImpl: async () => new Response(`<title>Page</title><p>${body}</p>`, { headers: { "content-type": "text/html" } }) });
  const first = await resolve("Original sentence.");
  assert.equal(first.sourceId, searchSource.sourceId);
  assert.equal(first.provenance?.kind, "reference");
  const read = await orchestrator.readSource(projectId, { sourceId: first.sourceId }, "agent");
  const citation = await orchestrator.addCitation(projectId, first.sourceId, { locator: { chunkId: read.chunks[0].chunkId }, quotedText: "Original sentence." });
  const updated = await resolve("Changed sentence.");
  assert.notEqual(updated.latestContentVersionId, first.latestContentVersionId);
  assert.equal(updated.reading?.status, "discovered");
  assert.equal((await repository.readCitation(projectId, citation.citationId))?.contentVersionId, first.latestContentVersionId);
  assert.match((await repository.readSourceContent(projectId, citation.contentVersionId!))!.text, /Original sentence/);
  const old = await orchestrator.readSource(projectId, { sourceId: first.sourceId, contentVersionId: first.latestContentVersionId }, "agent");
  assert.match(old.chunks[0].text, /Original sentence/);
  assert.equal((await repository.readSource(projectId, first.sourceId))?.reading?.status, "discovered");
  const content = (await repository.readSourceContent(projectId, first.latestContentVersionId!))!;
  await assert.rejects(repository.saveSourceContent({ ...content, origin: "replaced" }), /immutable/);
}));

test("citation verification rejects contradictory locations and does not infer absence from the full paper", async () => fixture(async (_root, _repository, orchestrator, projectId) => {
  const source = await orchestrator.resolveReference(projectId, "10.1234/fixture", { fetchImpl: async () => new Response(JSON.stringify({ message: { title: ["Abstract only"], abstract: "Known abstract sentence." } })) });
  const read = await orchestrator.readSource(projectId, { sourceId: source.sourceId }, "agent");
  assert.equal(read.content.scope, "abstract");
  assert.equal(read.receipt.audience, "agent");
  const valid = await orchestrator.addCitation(projectId, source.sourceId, { locator: { chunkId: read.chunks[0].chunkId }, quotedText: "Known abstract sentence." });
  assert.equal(valid.verification?.quoteMatches, true);
  const mismatch = await orchestrator.addCitation(projectId, source.sourceId, { locator: { chunkId: read.chunks[0].chunkId }, quotedText: "Possibly elsewhere in full text." });
  assert.equal(mismatch.verification?.status, "not-in-available-content");
  const badPage = await orchestrator.addCitation(projectId, source.sourceId, { locator: { chunkId: read.chunks[0].chunkId, page: 99 }, quotedText: "Known abstract sentence." });
  assert.equal(badPage.verification?.status, "invalid-location");
  const badOffset = await orchestrator.addCitation(projectId, source.sourceId, { locator: { startOffset: 0, endOffset: 999 }, quotedText: "Known abstract sentence." });
  assert.equal(badOffset.verification?.locatorValid, false);
  await assert.rejects(orchestrator.addCitation(projectId, "other-source", { contentVersionId: read.content.contentVersionId }), /source not found/);
  const other = await orchestrator.addSource(projectId, { title: "Other" });
  await assert.rejects(orchestrator.addCitation(projectId, other.sourceId, { contentVersionId: read.content.contentVersionId }), /does not belong/);
}));

test("OCR blank pages keep their physical number and large pages are split without claiming full truncated reading", async () => fixture(async (root, repository, _orchestrator, projectId) => {
  const file = path.join(root, "scan.pdf");
  await writeFile(file, "%PDF-1.4 image-only fixture");
  const ocrProvider = { provider: "fixture-ocr", async recognize() { return { text: "provider summary", pages: [{ text: "" }, { text: "Page two " + "X".repeat(9000), confidence: 0.9 }, { text: "Page three." }] }; } };
  const doc = await parseResearchDocument(file, { ocr: ocrProvider, maxText: 4500 });
  assert.equal(doc.truncated, true);
  assert.equal(doc.chunks[0].page, 2);
  assert.equal(doc.chunks[doc.chunks.length - 1].endOffset, doc.text.length);
  assert.ok(doc.chunks.every((chunk) => chunk.text.length <= 4000 && chunk.startOffset < chunk.endOffset));
  const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { ocrProvider });
  const { source } = await orchestrator.ingestDocument(projectId, file);
  const read = await orchestrator.readSource(projectId, { sourceId: source.sourceId, limit: 3 }, "agent");
  assert.equal(read.chunks[0].page, 2);
  assert.equal(read.chunks[2].page, 2);
  const next = await orchestrator.readSource(projectId, { sourceId: source.sourceId, offset: read.nextOffset!, limit: 1 }, "agent");
  assert.equal(next.chunks[0].page, 3);
  assert.equal((await repository.readSource(projectId, source.sourceId))?.reading?.status, "full-text-read");
  const huge = path.join(root, "large.txt"); await writeFile(huge, "x".repeat(200_100));
  const truncated = await orchestrator.ingestDocument(projectId, huge);
  for (let offset = 0; offset < 50; offset += 3) await orchestrator.readSource(projectId, { sourceId: truncated.source.sourceId, offset, limit: 3 }, "agent");
  assert.equal((await repository.readSource(projectId, truncated.source.sourceId))?.reading?.status, "partially-read");
}));

test("scoped bridge exposes bounded inventory and reading while refusing model-authored review actions", async () => fixture(async (root, repository, orchestrator, projectId) => {
  const file = path.join(root, "bridge.txt"); await writeFile(file, "REAL_BODY_MARKER" + "q".repeat(15000));
  const bridge = await startResearchBridge(orchestrator, { runnerProjectId: projectId });
  const request = async (input: unknown) => {
    const response = await fetch(bridge.url, { method: "POST", headers: { authorization: `Bearer ${bridge.token}`, "content-type": "application/json" }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const acquired = await request({ action: "document", file });
    assert.equal(acquired.status, 200);
    assert.equal(JSON.stringify(acquired.body).includes("REAL_BODY_MARKER"), false);
    assert.equal((await repository.listSourceReads(projectId)).length, 0);
    const read = await request({ action: "source-read", sourceId: acquired.body.source.sourceId, limit: 1, audience: "workspace", attemptId: "forged" });
    assert.equal(read.status, 200);
    assert.equal(read.body.receipt.audience, "agent");
    assert.notEqual(read.body.receipt.attemptId, "forged");
    assert.ok(JSON.stringify(read.body).length < 12_000);
    assert.equal((await request({ action: "source-read", sourceId: acquired.body.source.sourceId, limit: 999 })).status, 400);
    assert.equal((await request({ action: "citation-review", status: "manually-supported" })).status, 400);
    assert.equal((await request({ action: "source-read", projectId: "other", sourceId: acquired.body.source.sourceId })).status, 400);
    const inspect = await request({ action: "inspect" });
    assert.equal(inspect.body.counts.sourceContents, 1);
    assert.equal(JSON.stringify(inspect.body).includes("REAL_BODY_MARKER"), false);
    const sources = await request({ action: "inspect", collection: "sources", limit: 1 });
    assert.equal(sources.body.records.length, 1);
    assert.equal(JSON.stringify(sources.body).includes("REAL_BODY_MARKER"), false);
    const snapshot = await repository.exportProject(projectId);
    assert.throws(() => researchInspection(snapshot, { limit: 100 }), /limit/);
  } finally { await bridge.close(); }
}));

test("search logs retain failures, canonical duplicates and unsupported pagination without promoting snippets to reading", async () => fixture(async (_root, repository, orchestrator, projectId) => {
  await assert.rejects(orchestrator.searchSources(projectId, "missing provider", undefined, { backend: "configured" }), /not configured/);
  const provider = { provider: "fixture", async search() { return { provider: "fixture", results: [{ title: "First", url: "https://example.test/a?utm_source=search", snippet: "Discovery only" }, { title: "Duplicate", url: "https://example.test/a" }, { title: "Unsupported", url: "file:///private" }] }; } };
  const found = await orchestrator.searchSources(projectId, "find supporting and opposing evidence", provider, { actor: "agent" });
  assert.equal(found.sources.length, 1);
  assert.equal(found.pagination.supported, false);
  const logs = await new ResearchRepository(repository.root).listSearchLogs(projectId);
  const failed = logs.find((log) => log.query === "missing provider")!;
  assert.equal(failed.status, "failed"); assert.equal(failed.failureKind, "configuration");
  const completed = logs.find((log) => log.searchId === found.searchId)!;
  assert.deepEqual(completed.results.map((result) => result.decision), ["retained", "duplicate", "filtered"]);
  assert.equal(completed.actor, "agent"); assert.equal(completed.taskId, "read");
  assert.equal((await repository.listSourceReads(projectId)).length, 0);
  assert.equal((await repository.listSourceContents(projectId)).length, 0);
}));

test("human support reviews bind one claim relation and stale views cannot approve changed claims", async () => fixture(async (root, repository, orchestrator, projectId) => {
  const file = path.join(root, "review.txt"); await writeFile(file, "Method A reduced error in condition X.");
  const { source } = await orchestrator.ingestDocument(projectId, file);
  const read = await orchestrator.readSource(projectId, { sourceId: source.sourceId }, "agent");
  const citation = await orchestrator.addCitation(projectId, source.sourceId, { locator: { chunkId: read.chunks[0].chunkId }, quotedText: "Method A reduced error in condition X." });
  const claim = await orchestrator.addClaim(projectId, { text: "Method A reduced error in condition X", citationIds: [citation.citationId] });
  const evidence = await orchestrator.addEvidence(projectId, { claimId: claim.claimId, citationId: citation.citationId, relation: "supports", rationale: "Condition X only", ...{ review: { status: "supported" } } });
  assert.equal(evidence.citationId, citation.citationId); assert.equal(evidence.sourceId, source.sourceId);
  assert.equal((await repository.listEvidenceReviews(projectId)).length, 0);
  const context = await orchestrator.evidenceReviewContext(projectId, evidence.evidenceId);
  await assert.rejects(orchestrator.reviewEvidence(projectId, evidence.evidenceId, { binding: context.binding, status: "supported", note: "" }), /note/);
  const review = await orchestrator.reviewEvidence(projectId, evidence.evidenceId, { binding: context.binding, status: "supported", note: "The quoted statement supports the limited condition X claim." });
  assert.equal(review.actor, "trusted-workspace");
  const otherClaim = await orchestrator.addClaim(projectId, { text: "Method A always outperforms", citationIds: [citation.citationId] });
  const otherEvidence = await orchestrator.addEvidence(projectId, { claimId: otherClaim.claimId, citationId: citation.citationId, relation: "supports" });
  assert.equal((await orchestrator.evidenceReviewContext(projectId, otherEvidence.evidenceId)).reviews.length, 0);
  const report = await orchestrator.generateReport(projectId);
  assert.ok(report.warnings.some((warning) => warning.includes(otherEvidence.evidenceId) && warning.includes("no current human")));
  assert.ok(!report.warnings.some((warning) => warning.includes(evidence.evidenceId) && warning.includes("no current human")));
  await repository.saveClaim({ ...claim, text: "Changed scope" });
  await assert.rejects(orchestrator.reviewEvidence(projectId, evidence.evidenceId, { binding: context.binding, status: "supported", note: "Stale view" }), /changed/);
  const reopened = new ResearchOrchestrator(new ResearchRepository(repository.root));
  assert.equal((await reopened.evidenceReviewContext(projectId, evidence.evidenceId)).reviews[0].current, false);
  assert.ok((await reopened.generateReport(projectId)).warnings.some((warning) => warning.includes(evidence.evidenceId) && warning.includes("no current human")));
}));

test("corrupted body fails closed before a read receipt can be recorded", async () => fixture(async (root, repository, orchestrator, projectId) => {
  const file = path.join(root, "original.txt"); await writeFile(file, "Original content.");
  const { source } = await orchestrator.ingestDocument(projectId, file);
  const stored = path.join(repository.root, "projects", projectId, "source-content", source.latestContentVersionId! + ".json");
  const content = JSON.parse(await readFile(stored, "utf8")); content.text = "tampered";
  await writeFile(stored, JSON.stringify(content));
  await assert.rejects(orchestrator.readSource(projectId, { sourceId: source.sourceId }, "agent"), /hash or text/);
  assert.equal((await repository.listSourceReads(projectId)).length, 0);
}));

test("public discovery bounds result count and only registers bibliographic candidates", async () => fixture(async (_root, repository, orchestrator, projectId) => {
  let requested: URL | undefined;
  const provider = new CrossrefSearchProvider(async (url) => {
    requested = new URL(String(url));
    return new Response(JSON.stringify({ message: { items: [{ DOI: "10.1234/real", title: ["Paper title"], abstract: "<p>Discovery snippet</p>" }, { DOI: "not-a-doi", title: ["Invalid"] }] } }));
  });
  const result = await orchestrator.searchSources(projectId, "a query & another term", provider);
  assert.equal(requested?.hostname, "api.crossref.org");
  assert.equal(requested?.searchParams.get("query.bibliographic"), "a query & another term");
  assert.equal(requested?.searchParams.get("rows"), "10");
  assert.equal(result.sources.length, 1); assert.equal(result.sources[0].reading?.status, "discovered");
  assert.equal(result.provider, "crossref-public"); assert.match(result.coverage, /not a comprehensive/);
  assert.equal((await repository.listSourceContents(projectId)).length, 0);
}));

test("restricted and metadata-only acquisition attempts are preserved without reclassifying an old body as newly fetched", async () => fixture(async (_root, repository, orchestrator, projectId) => {
  await assert.rejects(orchestrator.resolveReference(projectId, "https://example.test/restricted", { fetchImpl: async () => new Response("secret diagnostic", { status: 403 }) }), /HTTP 403/);
  const source = await orchestrator.resolveReference(projectId, "10.1234/old", { fetchImpl: async () => new Response(JSON.stringify({ message: { title: ["Original"], abstract: "Available abstract" } })) });
  await orchestrator.resolveReference(projectId, "10.1234/old", { fetchImpl: async () => new Response(JSON.stringify({ message: { title: ["Metadata only now"] } })) });
  const logs = await repository.listSourceAcquisitions(projectId);
  assert.equal(logs.find((log) => log.origin.includes("restricted"))?.status, "restricted");
  assert.equal(JSON.stringify(logs).includes("secret diagnostic"), false);
  assert.ok(logs.some((log) => log.status === "available" && log.contentVersionId === source.latestContentVersionId));
  assert.ok(logs.some((log) => log.status === "metadata-only" && !log.contentVersionId));
  assert.ok(await repository.readSourceContent(projectId, source.latestContentVersionId!));
}));

test("result-submitted citation evidence keeps payload identity and resolves its source before committing", async () => fixture(async (root, repository, orchestrator, projectId) => {
  const file = path.join(root, "result-source.txt"); await writeFile(file, "A directly locatable statement.");
  const { source } = await orchestrator.ingestDocument(projectId, file);
  const read = await orchestrator.readSource(projectId, { sourceId: source.sourceId }, "agent");
  const citation = await orchestrator.addCitation(projectId, source.sourceId, { locator: { chunkId: read.chunks[0].chunkId }, quotedText: "A directly locatable statement." });
  const task = (await repository.exportProject(projectId)).plan!.tasks[0];
  const result = { ...taskResultIdentity(task), projectId, taskId: task.taskId, status: "completed", summary: "Source review candidate; human support review pending", refs: [citation.citationId], claims: [{ text: "A directly locatable statement.", citationIds: [citation.citationId] }], evidence: [{ claimIndex: 0, relation: "supports", citationId: citation.citationId }] };
  await orchestrator.submitTaskResult(projectId, result);
  const reopened = new ResearchOrchestrator(new ResearchRepository(repository.root));
  await reopened.submitTaskResult(projectId, result);
  const snapshot = await repository.exportProject(projectId);
  assert.equal(snapshot.claims.length, 1); assert.equal(snapshot.evidence.length, 1);
  assert.equal(snapshot.evidence[0].sourceId, source.sourceId);
  assert.equal(snapshot.evidence[0].citationId, citation.citationId);
  assert.equal((await repository.readResultCommit(projectId, result.submissionId))?.status, "committed");
}));
