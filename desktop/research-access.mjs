import { randomUUID } from "node:crypto";

const reads = ["list", "refresh", "open-readonly", "security-audits", "approval-queue", "budget-read", "export", "source-preview", "evidence-review-context", "report-read", "report-review-current", "report-review-context", "report-export", "memory-retrievals", "memory-conflicts", "experiment-review"];
const writes = ["create", "budget-update", "activate", "start-next", "approve", "complete", "fail", "pause", "resume", "replan", "iterate", "search", "add-source", "add-citation", "add-claim", "add-evidence", "ingest-document", "reference", "relate-sources", "source-read", "evidence-review", "report", "report-review", "remember", "memory-search", "memory-index-rebuild", "memory-review", "memory-review-batch", "create-experiment", "approve-experiment", "approve-experiment-design", "review-experiment-design", "execute-experiment", "run-agent", "cancel-agent"];
export const researchIpcPolicies = Object.freeze(Object.fromEntries([...reads.map((name) => [`research:${name}`, "read"]), ...writes.map((name) => [`research:${name}`, "write"])]));

function deny(message, reason) { const error = new Error(message); error.code = "DSH_SCI_RESEARCH_CAPABILITY_DENIED"; error.reason = reason; throw error; }

/** Only the main process binds window roles and the exact generated documents they may load. */
export function createResearchWindowRegistry() {
  const sessions = new WeakMap();
  const requireWindow = (event) => {
    const sender = event.sender, session = sender && sessions.get(sender);
    if (!session || sender.isDestroyed() || !event.senderFrame || event.senderFrame !== sender.mainFrame || !session.documents.has(event.senderFrame.url)) deny("Research Workspace window or document is not authorized", "authentication");
    return session;
  };
  return {
    bind(window, access, url) {
      if (!["owner", "read-only"].includes(access) || typeof url !== "string" || !url.startsWith("data:text/html;charset=utf-8,")) throw new Error("Invalid Research Workspace session");
      const sender = window.webContents;
      if (sessions.has(sender)) throw new Error("Research Workspace session is already bound");
      const session = { access, documents: new Set([url]) }; sessions.set(sender, session);
      const guard = (event, destination) => { if (!session.documents.has(destination)) event.preventDefault(); };
      sender.on("will-navigate", guard); sender.on("will-redirect", guard);
      sender.setWindowOpenHandler(() => ({ action: "deny" }));
      sender.once("destroyed", () => sessions.delete(sender));
    },
    requireWindow,
    require(event, channel) {
      const session = requireWindow(event), permission = Object.hasOwn(researchIpcPolicies, channel) ? researchIpcPolicies[channel] : undefined;
      if (!permission || (session.access === "read-only" && permission !== "read")) deny("Read-only Research Workspace capability refuses this action", "capability");
      return session.access;
    },
    access(event) { return requireWindow(event).access; },
    permitDocument(sender, url) {
      const session = sessions.get(sender);
      if (!session || typeof url !== "string" || !url.startsWith("data:text/html;charset=utf-8,")) throw new Error("Invalid Research Workspace document");
      session.documents.add(url);
      while (session.documents.size > 2) session.documents.delete(session.documents.values().next().value);
    },
  };
}

/** Every registered research handler is checked before entering the repository or orchestrator. */
export function createResearchIpcRegistrar(ipcMain, registry, { auditDenied } = {}) {
  return { handle(channel, handler) {
    if (!Object.hasOwn(researchIpcPolicies, channel)) throw new Error("Research IPC requires an explicit permission policy");
    ipcMain.handle(channel, async (event, ...args) => {
      try { registry.require(event, channel); }
      catch (error) {
        try { await auditDenied?.({ requestId: randomUUID(), action: channel.slice("research:".length), outcome: "rejected", reason: error.reason === "capability" ? "capability" : "authentication" }); }
        catch { process.emitWarning("Research security audit persistence is unavailable", { code: "DSH_SCI_SECURITY_AUDIT_UNAVAILABLE" }); }
        throw error;
      }
      return handler(event, ...args);
    });
  } };
}
