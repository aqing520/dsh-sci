import test from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error dashboard module is intentionally plain ESM JavaScript.
import { renderCaptureDashboard } from "../desktop/capture-dashboard.mjs";
// @ts-expect-error dashboard module is intentionally plain ESM JavaScript.
import { renderResearchDashboard } from "../desktop/research-dashboard.mjs";

test("capture dashboard escapes local metadata", () => {
  const html = renderCaptureDashboard({ status: { state: "capturing", workspaceRoot: "<workspace>" }, settings: { enabled: true, maxSnapshots: 20, maxResearchRecords: 30, retentionDays: 7 }, records: [{ runId: "run-123456789012", createdAt: "2026-10-28T00:00:00Z", sessionId: "s1", status: "partial", execution: { provider: "custom", model: "mock" }, outputs: { changedFiles: 0 }, workspaceSnapshotId: "snapshot-123456789012" }], snapshots: [], sessions: [{ sessionId: "s1", status: "active", eventCount: 2, toolAttribution: "partial", observedPaths: ["a.txt"] }], sessionEvents: { s1: [{ type: "tool/result", safe: true }] }, backupPublications: [{ createdAt: "2026-10-28T00:00:00Z", status: "failed", manifestId: "manifest-123", provider: "remote", error: "offline" }], queueItems: [{ jobId: "job-123456789", createdAt: "2026-10-28T00:00:00Z", state: "retrying", attempts: 1, maxAttempts: 3, nextAttemptAt: "2026-10-28T00:01:00Z", lastError: "offline" }] });
  assert.match(html, /&lt;workspace&gt;/);
  assert.doesNotMatch(html, /<workspace>/);
  assert.match(html, /run-12345678/);
  assert.match(html, /Observed paths/);
  assert.match(html, /Backup publications/);
  assert.match(html, /offline/);
  assert.match(html, /Capture settings/);
  assert.match(html, /value="20"/);
  assert.match(html, /Apply cleanup now/);
  assert.match(html, /<details>/);
  assert.match(html, /Backup queue/);
  assert.match(html, /retrying/);
  assert.match(html, /retry-backup/);
  assert.match(html, /tool\/result/);
  assert.match(html, /Session timeline/);
  assert.match(html, /Research runs/);
  assert.match(html, /Artifacts and observed paths/);
  assert.match(html, /Artifacts/);
  assert.match(html, /Service tools/);
  assert.match(html, /Effective configuration/);
  assert.match(html, /Model gateway/);
  assert.match(html, /runtime-settings-form/);
  assert.match(html, /Save non-sensitive settings/);
  assert.match(html, /api\.runtimeSettings/);
  assert.match(html, /Service status/);
  assert.match(html, /quota-state/);
  assert.match(html, /renderServiceSearch/);
  assert.match(html, /renderQuota/);
  assert.match(html, /Local history search/);
  assert.match(html, /api\.localSearch/);
  assert.match(html, /local-search-kind/);
  assert.match(html, /value="artifact"/);
  assert.match(html, /local-search-session/);
  assert.match(html, /local-search-project/);
  assert.match(html, /local-search-since/);
  assert.match(html, /Service not configured/);
  assert.match(html, /id="refresh"/);
  assert.match(html, /api\.refresh/);
  assert.match(html, /Download recovery audit/);
  assert.match(html, /Recovery audit/);
  assert.match(html, /api\.recoveryAudit/);
  assert.match(html, /Restore metadata bundle/);
  assert.match(html, /choose-bundle/);
  assert.match(html, /choose-target/);
  assert.match(html, /api\.restoreBundle/);
  const runHtml = renderCaptureDashboard({
    status: { state: "idle" },
    settings: { enabled: true, maxSnapshots: 1, maxResearchRecords: 1 },
    sessions: [],
    researchRuns: [{
      runId: "run-detail",
      sessionId: "session-detail",
      startedAt: "2026-10-29T00:00:00.000Z",
      lastObservedAt: "2026-10-29T00:00:02.000Z",
      state: "disposed",
      outcome: "unverified",
      execution: { provider: "test-provider", model: "test-model", toolAttribution: "partial" },
      eventCount: 2,
      observations: { inputEvents: 0, outputEvents: 1, toolEvents: 1, errorEvents: 0 },
      observedCalls: [{ kind: "tool", id: "<call>", count: 2, errorObserved: false, firstObservedAt: "2026-10-29T00:00:00.000Z", lastObservedAt: "2026-10-29T00:00:01.000Z", firstSeq: 1, lastSeq: 2, eventTypes: ["tool/result"] }],
    }],
    sessionEvents: {
      "session-detail": [{ capturedAt: "2026-10-29T00:00:01.000Z", classification: "tool", event: { type: "tool/result", seq: 2, correlations: [{ kind: "tool", id: "<call>" }], observedPaths: ["secret-path"] } }],
    },
  });
  assert.match(runHtml, /test-provider\/test-model/);
  assert.match(runHtml, /Timeline · 1 calls · 1 events/);
  assert.match(runHtml, /Observed calls/);
  assert.match(runHtml, /&lt;call&gt;/);
  assert.match(runHtml, /Session event order/);
  assert.doesNotMatch(runHtml, /<call>/);
  const snapshotHtml = renderCaptureDashboard({
    status: { state: "capturing" },
    settings: { enabled: true, maxSnapshots: 1, maxResearchRecords: 1 },
    snapshots: [{ capturedAt: "2026-10-29T00:00:00.000Z", sequence: 2, snapshotId: "snapshot-1", files: [{ path: "result.txt" }], changes: { added: ["new.txt"], changed: ["result.txt"], removed: ["old.txt"] } }],
  });
  assert.match(snapshotHtml, /Diff details/);
  assert.match(snapshotHtml, /Added files/);
  assert.match(snapshotHtml, /new\.txt/);
  assert.match(snapshotHtml, /Changed files/);
  assert.match(snapshotHtml, /Removed files/);
  const configured = renderCaptureDashboard({ status: { state: "idle" }, settings: { enabled: true, maxSnapshots: 1, maxResearchRecords: 1 }, records: [], snapshots: [], sessions: [], provider: { provider: "openai", model: "test-model", baseUrl: "https://api.example.test/v1?token=secret", timeoutMs: 1234, keyConfigured: true }, service: { configured: true, provider: "research-http", baseUrl: "https://service.example.test/api", timeoutMs: 5000, retries: 2, keyConfigured: true } });
  assert.match(configured, /research-http/);
  assert.match(configured, /test-model/);
  assert.match(configured, /https:\/\/api\.example\.test\/v1/);
  assert.doesNotMatch(configured, /token=secret/);
  assert.match(configured, /configured \(hidden\)/);
  const hostile = renderCaptureDashboard({ status: { state: "<state>" }, settings: { enabled: true, maxSnapshots: 1, maxResearchRecords: 1 }, records: [{ runId: "r", createdAt: "<date>", status: "<status>", execution: {}, outputs: { changedFiles: "<count>" }, workspaceSnapshotId: "s" }], snapshots: [], sessions: [], queueItems: [] });
  assert.doesNotMatch(hostile, /<state>|<date>|<status>|<count>/);
  const locked = renderCaptureDashboard({ status: { state: "locked", error: "unlock required" }, settings: { enabled: false, maxSnapshots: 1, maxResearchRecords: 1 } });
  assert.match(locked, /DSH_SCI_METADATA_PASSPHRASE/);
  assert.match(locked, /unlock required/);
});

test("research dashboard exposes HTML evidence graph export", () => {
  const html = renderResearchDashboard({ projects: [{ projectId: "p1", title: "Question", question: "Why?", status: "planning", iteration: 0 }] });
  assert.match(html, /导出已有 HTML 证据图/);
  assert.match(html, /report-html/);
  assert.match(html, /\.html/);
  assert.match(html, /查看记忆冲突/);
  assert.match(html, /审阅记忆冲突/);
  assert.match(html, /review-conflicts/);
  assert.match(html, /reviewMemoryConflict/);
  assert.match(html, /reviewMemoryConflictsBatch/);
  assert.match(html, /memory-review-batch-form/);
  assert.match(html, /批量保存审阅/);
  assert.match(html, /全选冲突组/);
  assert.match(html, /研究记忆检索/);
  assert.match(html, /memory-search-form/);
  assert.match(html, /minConfidence/);
  assert.match(html, /selectedMemoryId/);
  assert.match(html, /研究审批队列/);
  assert.match(html, /listApprovalQueue/);
  assert.match(html, /api\.reportReviewContext/);
  assert.match(html, /api\.exportReport/);
});

test("read-only research dashboard escapes saved data and exposes viewing actions", () => {
  const html = renderResearchDashboard({ readOnly: true, projects: [{ projectId: 'p" onclick="injected', title: "<img src=x>", question: "<script>injected</script>", status: "paused" }] });
  assert.match(html, /data-research-access="read-only"/u);
  assert.match(html, /&lt;img src=x&gt;/u);
  assert.match(html, /&lt;script&gt;injected&lt;\/script&gt;/u);
  assert.match(html, /api\.previewSource/u);
  assert.match(html, /api\.reportReviewContext/u);
  assert.doesNotMatch(html, /<img|<script>injected|id="create"|api\.(approve|remember|generateReport|readSource|searchMemory)\(/u);
});
