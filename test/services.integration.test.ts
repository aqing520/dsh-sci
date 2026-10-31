import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackupQueue } from "../src/backup-queue.js";
import { CaptureStore } from "../src/capture.js";
import { HttpBackupPublisher, HttpQuotaProvider, HttpSearchProvider } from "../src/services.js";

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

test("HTTP service adapters interoperate with a real local server", async () => {
  const requests: Array<{ path: string; authorization?: string; idempotencyKey?: string; body?: any }> = [];
  let backupAttempts = 0;
  const server = createServer(async (request, response) => {
    const body = request.method === "POST" ? await bodyOf(request) : "";
    requests.push({ path: request.url ?? "", authorization: request.headers.authorization, idempotencyKey: request.headers["idempotency-key"] as string | undefined, body: body ? JSON.parse(body) : undefined });
    if (request.url === "/search") return json(response, 200, { results: [{ title: "Local result", url: "https://docs.example/result", snippet: "from server" }] });
    if (request.url === "/quota") return json(response, 200, { remaining: 7, limit: 10, resetAt: "2026-10-29T00:00:00Z" });
    if (request.url === "/backup/manifests") {
      backupAttempts += 1;
      if (backupAttempts === 1) return json(response, 503, { error: "retry" });
      response.writeHead(204);
      return response.end();
    }
    response.writeHead(404);
    return response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const config = { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "integration-secret", timeoutMs: 2_000, retries: 1, provider: "local-integration" };
  try {
    const search = await new HttpSearchProvider(config).search("hello", { limit: 4 });
    assert.deepEqual(search.results, [{ title: "Local result", url: "https://docs.example/result", snippet: "from server", source: undefined }]);
    const quota = await new HttpQuotaProvider(config).getQuota();
    assert.deepEqual(quota, { provider: "local-integration", status: "available", remaining: 7, limit: 10, resetAt: "2026-10-29T00:00:00Z", message: undefined });
    const backup = await new HttpBackupPublisher(config).publish({ schema: "dsh-sci.backup-manifest.v1", projectId: "project-1", workspaceSnapshotIds: ["snapshot-1"], researchRunIds: ["run-1"], contentPolicy: "metadata-only" });
    assert.equal(backup.uploaded, true);
    const searchRequest = requests.find((request) => request.path === "/search");
    assert.equal(searchRequest?.authorization, "Bearer integration-secret");
    assert.deepEqual(searchRequest?.body, { query: "hello", limit: 4 });
    const backupRequests = requests.filter((request) => request.path === "/backup/manifests");
    assert.equal(backupRequests.length, 2);
    assert.equal(backupRequests[0].idempotencyKey, backupRequests[1].idempotencyKey);
    assert.equal(backupRequests[1].idempotencyKey, backup.manifest.manifestId);
    assert.equal(backupRequests[1].body.contentPolicy, "metadata-only");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("backup queue publishes a captured metadata set through the HTTP publisher", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "dsh-sci-http-queue-"));
  const workspace = path.join(parent, "workspace");
  const root = path.join(parent, "capture");
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    const body = request.method === "POST" ? await bodyOf(request) : "";
    if (body) requests.push(JSON.parse(body));
    response.writeHead(204);
    response.end();
  });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "result.txt"), "captured", "utf8");
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const store = new CaptureStore(root);
    const snapshot = await store.snapshot(workspace);
    const config = { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "queue-secret", timeoutMs: 2_000, retries: 0, provider: "queue-local" };
    const queue = new BackupQueue(store, new HttpBackupPublisher(config), { baseDelayMs: 0 });
    await queue.enqueue();
    const result = await queue.process();
    assert.equal(result.published, 1);
    assert.equal((await queue.list())[0]?.state, "published");
    assert.deepEqual(requests[0].workspaceSnapshotIds, [snapshot.snapshotId]);
    assert.equal(requests[0].contentPolicy, "metadata-only");
  } finally {
    server.close();
    await once(server, "close");
    await rm(parent, { recursive: true, force: true });
  }
});
