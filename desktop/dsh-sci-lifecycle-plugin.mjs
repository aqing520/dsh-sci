import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, scryptSync } from "node:crypto";

export const name = "dsh-sci-lifecycle";

const SENSITIVE_KEY = /(api[-_]?key|authorization|cookie|password|secret|token|credential)/iu;
const MAX_TEXT = 4_096;
const MAX_DEPTH = 4;
const ENCRYPTED_SCHEMA = "dsh-sci.encrypted-metadata.v1";
const SCRYPT_PARAMS = { N: 16_384, r: 8, p: 1 };

function metadataPassphrase() {
  return typeof process.env.DSH_SCI_METADATA_PASSPHRASE === "string" && process.env.DSH_SCI_METADATA_PASSPHRASE.length > 0 ? process.env.DSH_SCI_METADATA_PASSPHRASE : undefined;
}
function metadataKey(passphrase, salt, params = SCRYPT_PARAMS) { return scryptSync(passphrase, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024 }); }
function decryptMetadataText(text, passphrase = metadataPassphrase()) {
  let value;
  try { value = JSON.parse(text); } catch { return text; }
  if (!value || value.schema !== ENCRYPTED_SCHEMA) return text;
  if (!passphrase) throw new Error("Metadata is encrypted; set DSH_SCI_METADATA_PASSPHRASE to unlock it");
  if (value.algorithm !== "aes-256-gcm" || value.kdf !== "scrypt" || value.kdfParams?.N !== SCRYPT_PARAMS.N || value.kdfParams?.r !== SCRYPT_PARAMS.r || value.kdfParams?.p !== SCRYPT_PARAMS.p) throw new Error("Encrypted metadata uses an unsupported algorithm");
  try {
    const decipher = createDecipheriv("aes-256-gcm", metadataKey(passphrase, Buffer.from(value.salt, "base64"), value.kdfParams), Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch { throw new Error("Metadata passphrase is invalid or the encrypted metadata is corrupted"); }
}
function encryptMetadataText(text, passphrase = metadataPassphrase()) {
  if (!passphrase) return text;
  const salt = randomBytes(16); const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", metadataKey(passphrase, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `${JSON.stringify({ schema: ENCRYPTED_SCHEMA, algorithm: "aes-256-gcm", kdf: "scrypt", kdfParams: SCRYPT_PARAMS, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }, null, 2)}\n`;
}
function decryptMetadataTextSync(text) { return decryptMetadataText(text); }
async function readMetadataText(file) { return decryptMetadataText(await readFile(file, "utf8")); }
async function appendMetadataLine(file, line) {
  if (!metadataPassphrase()) { await appendFile(file, line, "utf8"); return; }
  let existing = "";
  try { existing = await readMetadataText(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, encryptMetadataText(existing + line), "utf8");
  await rename(temporary, file);
}

function rootDirectory() {
  return path.resolve(process.env.DSH_SCI_CAPTURE_ROOT ?? path.join(process.env.DSH_HOME ?? ".", "dsh-sci-capture"));
}

function safeValue(value, depth = 0) {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    const text = value.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").replace(/(sk|key|token)[-_][A-Za-z0-9_-]{8,}/giu, "$1-[redacted]");
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  }
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => safeValue(item, depth + 1));
  if (typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 80)) output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : safeValue(item, depth + 1);
    return output;
  }
  return String(value);
}

function observedPaths(value, depth = 0, result = new Set()) {
  if (depth > 4 || result.size >= 100) return result;
  if (typeof value === "string") {
    if (value.length <= 512 && (/[/\\]/.test(value) || /\.[A-Za-z0-9]{1,8}$/.test(value))) result.add(value);
    return result;
  }
  if (Array.isArray(value)) { for (const item of value.slice(0, 40)) observedPaths(item, depth + 1, result); return result; }
  if (value && typeof value === "object") { for (const [key, item] of Object.entries(value).slice(0, 80)) { if (/path|file|cwd|workspace|directory|attachment/i.test(key)) observedPaths(item, depth + 1, result); } }
  return result;
}

function classifyEvent(type) {
  const value = String(type ?? "").toLowerCase();
  if (/error|fail|exception/.test(value)) return "error";
  if (/tool|command|function|exec/.test(value)) return "tool";
  if (/input|prompt|user|request|message/.test(value)) return "input";
  if (/output|result|response|assistant|completion|answer/.test(value)) return "output";
  if (/status|state/.test(value)) return "status";
  return "other";
}

function eventCorrelations(type, value, depth = 0, result = []) {
  if (depth > 4 || result.length >= 20 || !value || typeof value !== "object") return result;
  const typeText = String(type ?? "").toLowerCase();
  const kind = /tool|command|function|exec/.test(typeText) ? "tool" : /model|llm|completion|response|assistant/.test(typeText) ? "model" : "unknown";
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    const keyText = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
    if (/(requestid|responseid|messageid|callid|toolcallid|completionid|traceid)/.test(keyText) && typeof item === "string" && item.length > 0 && item.length <= 128 && /^[A-Za-z0-9._:-]+$/u.test(item)) result.push({ kind, id: item, key });
    if (item && typeof item === "object") eventCorrelations(type, item, depth + 1, result);
    if (result.length >= 20) break;
  }
  return result;
}

function modelMetadata(value, depth = 0, result = {}) {
  if (depth > 4 || !value || typeof value !== "object") return result;
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    const normalized = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
    if ((normalized === "model" || normalized === "provider") && typeof item === "string" && item.length <= 128 && !result[normalized]) result[normalized] = item;
    if (item && typeof item === "object") modelMetadata(item, depth + 1, result);
  }
  return result;
}

function sessionIdOf(session) { return String(session?.id ?? "unknown"); }
function sessionDirectory(root, sessionId) {
  const encoded = encodeURIComponent(String(sessionId));
  const safe = encoded === "." ? "%2E" : encoded === ".." ? "%2E%2E" : encoded;
  return path.join(root, "sessions", safe);
}
function workspaceMetadata(root) {
  try {
    const value = JSON.parse(decryptMetadataTextSync(readFileSync(path.join(root, "workspace-index.json"), "utf8")));
    const metadata = { projectId: value.projectId, workspaceSnapshotId: value.latest, workspaceRoot: value.workspaceRoot };
    Object.defineProperty(metadata, "workspaceFiles", { value: Array.isArray(value.files) ? value.files : [], enumerable: false });
    return metadata;
  } catch { return {}; }
}
function artifactMetadata(observed, metadata) {
  const workspaceRoot = typeof metadata.workspaceRoot === "string" ? path.resolve(metadata.workspaceRoot) : undefined;
  const files = Array.isArray(metadata.workspaceFiles) ? metadata.workspaceFiles : [];
  return observed.map((observedPath) => {
    const absolute = path.isAbsolute(observedPath) ? path.resolve(observedPath) : undefined;
    const relativePath = absolute && workspaceRoot ? path.relative(workspaceRoot, absolute).replaceAll("\\", "/") : undefined;
    const file = relativePath ? files.find((candidate) => String(candidate.path).replaceAll("\\", "/") === relativePath) : undefined;
    return {
      artifactId: createHash("sha256").update(`${metadata.projectId ?? ""}\0${observedPath}`).digest("hex").slice(0, 32),
      path: observedPath,
      relativePath,
      location: absolute && workspaceRoot && !relativePath.startsWith("..") && !path.isAbsolute(relativePath) ? "workspace" : "external",
      kind: file?.kind ?? "observed-path",
      bytes: typeof file?.bytes === "number" ? file.bytes : undefined,
      sha256: typeof file?.sha256 === "string" ? file.sha256 : undefined,
      projectId: metadata.projectId,
      workspaceSnapshotId: metadata.workspaceSnapshotId,
    };
  });
}
function eventRecord(session, event, metadata) {
  const data = safeValue(event.data);
  const paths = [...observedPaths(data)];
  const correlations = eventCorrelations(event.type, data).map(({ kind, id }) => ({ kind, id }));
  return {
    schema: "dsh-sci.session-event.v1",
    capturedAt: new Date().toISOString(),
    session: { id: sessionIdOf(session), cwd: typeof session.header?.cwd === "string" ? session.header.cwd : undefined, origin: typeof session.header?.origin === "string" ? session.header.origin : undefined },
    event: { type: event.type, seq: Number(event.seq), time: event.time, data, observedPaths: paths, artifacts: artifactMetadata(paths, metadata), correlations },
    classification: classifyEvent(event.type),
  };
}

export function apply(ctx) {
  const root = rootDirectory();
  const aggregateFile = path.join(root, "sessions", "dsh-session-events.jsonl");
  const artifactIndexFile = path.join(root, "artifacts", "index.json");
  let queue = Promise.resolve();
  let closed = false;
  const sessions = new Map();
  const researchRuns = new Map();
  const write = (record, sessionId) => {
    if (closed) return;
    queue = queue.then(async () => {
      const directory = sessionId ? sessionDirectory(root, sessionId) : path.join(root, "sessions");
      await mkdir(directory, { recursive: true });
      const artifacts = Array.isArray(record?.event?.artifacts) ? record.event.artifacts : [];
      if (artifacts.length) {
        await mkdir(path.dirname(artifactIndexFile), { recursive: true });
        let existing = [];
        try { existing = JSON.parse(await readMetadataText(artifactIndexFile)).artifacts ?? []; } catch (error) { if (error.code !== "ENOENT") throw error; }
        const now = record.capturedAt ?? new Date().toISOString();
        for (const artifact of artifacts) {
          const prior = existing.find((item) => item.artifactId === artifact.artifactId);
          if (prior) Object.assign(prior, artifact, { firstSeenAt: prior.firstSeenAt ?? now, lastSeenAt: now, observedCount: Number(prior.observedCount ?? 0) + 1, sessionIds: [...new Set([...(prior.sessionIds ?? []), sessionId])] });
          else existing.push({ schema: "dsh-sci.artifact.v1", ...artifact, firstSeenAt: now, lastSeenAt: now, observedCount: 1, sessionIds: sessionId ? [sessionId] : [] });
        }
        const artifactTemporary = `${artifactIndexFile}.${randomUUID()}.tmp`;
        await writeFile(artifactTemporary, encryptMetadataText(`${JSON.stringify({ schema: "dsh-sci.artifact-index.v1", artifacts: existing.slice(-10_000) }, null, 2)}\n`), "utf8");
        await rename(artifactTemporary, artifactIndexFile);
      }
      const line = `${JSON.stringify(record)}\n`;
      await appendMetadataLine(aggregateFile, line);
      if (sessionId) await appendMetadataLine(path.join(directory, "events.jsonl"), line);
    }).catch((error) => ctx.logger.warn(`dsh-sci lifecycle capture failed: ${String(error)}`));
  };
  const updateSession = (sessionId, patch) => {
    const current = sessions.get(sessionId) ?? { schema: "dsh-sci.session-index.v1", sessionId, eventCount: 0, ...workspaceMetadata(root) };
    const next = { ...current, ...patch };
    sessions.set(sessionId, next);
    queue = queue.then(async () => {
      const directory = sessionDirectory(root, sessionId);
      await mkdir(directory, { recursive: true });
      const target = path.join(directory, "session.json");
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, encryptMetadataText(`${JSON.stringify(next, null, 2)}\n`), "utf8");
      await rename(temporary, target);
      const sessionsFile = path.join(root, "sessions", "index.json");
      let records = [];
      try { records = JSON.parse(await readMetadataText(sessionsFile)).sessions ?? []; } catch (error) { if (error.code !== "ENOENT") throw error; }
      const withoutCurrent = records.filter((record) => record.sessionId !== sessionId);
      const indexTemporary = `${sessionsFile}.${randomUUID()}.tmp`;
      await writeFile(indexTemporary, encryptMetadataText(`${JSON.stringify({ schema: "dsh-sci.session-index.v1", sessions: [...withoutCurrent, next] }, null, 2)}\n`), "utf8");
      await rename(indexTemporary, sessionsFile);
    }).catch((error) => ctx.logger.warn(`dsh-sci session index failed: ${String(error)}`));
  };
  const updateResearchRun = (sessionId, patch) => {
    const now = new Date().toISOString();
    const current = researchRuns.get(sessionId) ?? { schema: "dsh-sci.research-run.v1", runId: randomUUID(), sessionId, startedAt: now, lastObservedAt: now, state: "active", outcome: "unverified", inputs: { status: "unverified", exactInputBaseline: false }, inputSummary: { status: "unverified", events: 0, observedPaths: 0 }, outputSummary: { status: "unverified", events: 0, observedPaths: 0 }, execution: { source: "dsh-session-observation", toolAttribution: "unavailable" }, eventCount: 0, observedPaths: [], artifactIds: [], eventTypes: {}, observations: { inputEvents: 0, outputEvents: 0, toolEvents: 0, errorEvents: 0, statusEvents: 0 }, observedCalls: [], ...workspaceMetadata(root) };
    const next = { ...current, ...patch, lastObservedAt: now };
    researchRuns.set(sessionId, next);
    queue = queue.then(async () => {
      const directory = path.join(root, "research-runs", encodeURIComponent(String(next.runId)));
      await mkdir(directory, { recursive: true });
      const target = path.join(directory, "run.json");
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, encryptMetadataText(`${JSON.stringify(next, null, 2)}\n`), "utf8");
      await rename(temporary, target);
      const indexFile = path.join(root, "research-runs", "index.json");
      const indexTemporary = `${indexFile}.${randomUUID()}.tmp`;
      const records = [...researchRuns.values()].sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
      await writeFile(indexTemporary, encryptMetadataText(`${JSON.stringify({ schema: "dsh-sci.research-run-index.v1", runs: records.slice(-10_000) }, null, 2)}\n`), "utf8");
      await rename(indexTemporary, indexFile);
    }).catch((error) => ctx.logger.warn(`dsh-sci research run capture failed: ${String(error)}`));
    return next;
  };
  ctx.on("session/created", (session) => {
    const sessionId = sessionIdOf(session);
    const run = updateResearchRun(sessionId, { ...workspaceMetadata(root), startedAt: new Date().toISOString(), state: "active" });
    updateSession(sessionId, { createdAt: new Date().toISOString(), cwd: typeof session.header?.cwd === "string" ? session.header.cwd : undefined, origin: typeof session.header?.origin === "string" ? session.header.origin : undefined, status: "created", researchRunId: run.runId });
    write({ schema: "dsh-sci.session-lifecycle.v1", type: "created", capturedAt: new Date().toISOString(), sessionId }, sessionId);
  });
  ctx.on("session/event", (session, event) => {
    const sessionId = sessionIdOf(session);
    const metadata = workspaceMetadata(root);
    const current = sessions.get(sessionId) ?? { schema: "dsh-sci.session-index.v1", sessionId, eventCount: 0, ...metadata };
    const paths = [...observedPaths(safeValue(event.data))];
    const artifacts = artifactMetadata(paths, metadata);
    updateSession(sessionId, { ...metadata, eventCount: current.eventCount + 1, lastEventAt: new Date().toISOString(), lastEventType: event.type, status: "active", toolAttribution: paths.length ? "partial" : current.toolAttribution, observedPaths: [...new Set([...(current.observedPaths ?? []), ...paths])].slice(0, 100), artifactIds: [...new Set([...(current.artifactIds ?? []), ...artifacts.map((artifact) => artifact.artifactId)])].slice(0, 100) });
    const run = researchRuns.get(sessionId) ?? updateResearchRun(sessionId, { ...metadata });
    const classification = classifyEvent(event.type);
    const observations = { ...(run.observations ?? { inputEvents: 0, outputEvents: 0, toolEvents: 0, errorEvents: 0, statusEvents: 0 }) };
    const correlations = eventCorrelations(event.type, safeValue(event.data));
    const observedAt = new Date().toISOString();
    const eventSeq = Number.isFinite(Number(event.seq)) ? Number(event.seq) : undefined;
    const model = modelMetadata(safeValue(event.data));
    if (classification === "input") observations.inputEvents += 1;
    if (classification === "output") observations.outputEvents += 1;
    if (classification === "tool") observations.toolEvents += 1;
    if (classification === "error") observations.errorEvents += 1;
    if (classification === "status") observations.statusEvents += 1;
    const inputSummary = { ...(run.inputSummary ?? { status: "unverified", events: 0, observedPaths: 0 }) };
    const outputSummary = { ...(run.outputSummary ?? { status: "unverified", events: 0, observedPaths: 0 }) };
    if (classification === "input") { inputSummary.events += 1; inputSummary.observedPaths += paths.length; }
    if (classification === "output") { outputSummary.events += 1; outputSummary.observedPaths += paths.length; }
    const observedCalls = [...(run.observedCalls ?? [])];
    for (const correlation of correlations) {
      const existing = observedCalls.find((item) => item.kind === correlation.kind && item.id === correlation.id);
      if (existing) { existing.count += 1; existing.lastObservedAt = observedAt; existing.lastSeq = eventSeq ?? existing.lastSeq; existing.errorObserved ||= classification === "error"; existing.eventTypes = [...new Set([...existing.eventTypes, String(event.type ?? "unknown")])].slice(0, 20); }
      else if (observedCalls.length < 100) observedCalls.push({ kind: correlation.kind, id: correlation.id, count: 1, eventTypes: [String(event.type ?? "unknown")], firstObservedAt: observedAt, lastObservedAt: observedAt, firstSeq: eventSeq, lastSeq: eventSeq, errorObserved: classification === "error" });
    }
    updateResearchRun(sessionId, { ...metadata, runId: run.runId, eventCount: Number(run.eventCount ?? 0) + 1, lastEventType: event.type, eventTypes: { ...(run.eventTypes ?? {}), [String(event.type ?? "unknown")]: Number(run.eventTypes?.[String(event.type ?? "unknown")] ?? 0) + 1 }, observations, inputSummary, outputSummary, observedCalls, observedPaths: [...new Set([...(run.observedPaths ?? []), ...paths])].slice(0, 100), artifactIds: [...new Set([...(run.artifactIds ?? []), ...artifacts.map((artifact) => artifact.artifactId)])].slice(0, 100), execution: { ...run.execution, provider: model.provider ?? run.execution?.provider, model: model.model ?? run.execution?.model, toolAttribution: paths.length ? "partial" : run.execution?.toolAttribution } });
    write(eventRecord(session, event, metadata), sessionId);
  });
  ctx.on("agent/status", ({ agent, status }) => {
    const sessionId = sessionIdOf(agent.session);
    updateSession(sessionId, { ...workspaceMetadata(root), agentStatus: status, lastEventAt: new Date().toISOString(), status: "active" });
    const run = researchRuns.get(sessionId) ?? updateResearchRun(sessionId, { ...workspaceMetadata(root) });
    updateResearchRun(sessionId, { runId: run.runId, agentStatus: String(status) });
    write({ schema: "dsh-sci.agent-status.v1", type: "agent-status", capturedAt: new Date().toISOString(), sessionId, status }, sessionId);
  });
  ctx.on("session/disposed", (session) => {
    const sessionId = sessionIdOf(session);
    updateSession(sessionId, { ...workspaceMetadata(root), disposedAt: new Date().toISOString(), status: "disposed" });
    const run = researchRuns.get(sessionId) ?? updateResearchRun(sessionId, { ...workspaceMetadata(root) });
    updateResearchRun(sessionId, { runId: run.runId, state: "disposed", disposedAt: new Date().toISOString() });
    write({ schema: "dsh-sci.session-lifecycle.v1", type: "disposed", capturedAt: new Date().toISOString(), sessionId }, sessionId);
  });
  ctx.on("session/flush", () => queue);
  ctx.effect(() => async () => { closed = true; await queue; });
}
