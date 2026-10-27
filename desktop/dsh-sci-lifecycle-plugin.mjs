import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const name = "dsh-sci-lifecycle";

const SENSITIVE_KEY = /(api[-_]?key|authorization|cookie|password|secret|token|credential)/iu;
const MAX_TEXT = 4_096;
const MAX_DEPTH = 4;

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

function eventRecord(session, event) {
  return {
    schema: "dsh-sci.session-event.v1",
    capturedAt: new Date().toISOString(),
    session: {
      id: String(session.id),
      cwd: typeof session.header?.cwd === "string" ? session.header.cwd : undefined,
      origin: typeof session.header?.origin === "string" ? session.header.origin : undefined,
    },
    event: { type: event.type, seq: Number(event.seq), time: event.time, data: safeValue(event.data) },
  };
}

export function apply(ctx) {
  const root = rootDirectory();
  const file = path.join(root, "sessions", "dsh-session-events.jsonl");
  let queue = Promise.resolve();
  let closed = false;
  const write = (record) => {
    if (closed) return;
    queue = queue.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
    }).catch((error) => ctx.logger.warn(`dsh-sci lifecycle capture failed: ${String(error)}`));
  };
  ctx.on("session/created", (session) => write({ schema: "dsh-sci.session-lifecycle.v1", type: "created", capturedAt: new Date().toISOString(), sessionId: String(session.id) }));
  ctx.on("session/event", (session, event) => write(eventRecord(session, event)));
  ctx.on("agent/status", ({ agent, status }) => write({ schema: "dsh-sci.agent-status.v1", type: "agent-status", capturedAt: new Date().toISOString(), sessionId: String(agent.session.id), status }));
  ctx.on("session/disposed", (session) => write({ schema: "dsh-sci.session-lifecycle.v1", type: "disposed", capturedAt: new Date().toISOString(), sessionId: String(session.id) }));
  ctx.on("session/flush", () => queue);
  ctx.effect(() => async () => { closed = true; await queue; });
}
