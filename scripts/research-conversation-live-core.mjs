import { readFile, writeFile, rename, open, unlink } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";

export function defaultCredentialFile(platform = process.platform, env = process.env, home = homedir()) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const data = platform === "win32" ? (env.APPDATA || paths.join(home, "AppData", "Roaming"))
    : platform === "darwin" ? paths.join(home, "Library", "Application Support")
    : (env.XDG_CONFIG_HOME || paths.join(home, ".config"));
  return paths.join(data, "dsh-sci", "harness", ".credentials.yaml");
}

export async function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}

// Only an explicit --resume retries an interrupted run. Never change session,
// workspace, model, endpoint or the existing research budget during recovery.
export async function loadResumeStatus(output, { model, baseUrl } = {}) {
  const status = JSON.parse(await readFile(path.join(output, "status.json"), "utf8"));
  if (status.schema !== "dsh-sci.native-live.v1" || typeof status.sessionId !== "string" || !status.sessionId
    || typeof status.model !== "string" || !status.model || typeof status.output !== "string"
    || path.resolve(status.output) !== output) throw new Error("Invalid live acceptance identity; resume the original directory on this machine.");
  if (status.state === "completed") throw new Error("This acceptance run already completed; review its saved evidence.");
  if ((model && model !== status.model) || (baseUrl && baseUrl !== status.baseUrl)) throw new Error("Resume must preserve the original model and endpoint.");
  return status;
}

export async function acquireRunLock(output) {
  const file = path.join(output, "run.lock");
  const acquire = async () => {
    const handle = await open(file, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid })); }
    catch (error) { await handle.close(); await unlink(file); throw error; }
    return async () => { await handle.close(); await unlink(file); };
  };
  try { return await acquire(); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    // Serialize stale-lock removal so two explicit retries cannot unlink a
    // newly acquired owner's lock. A failed reclaim guard requires inspection.
    const reclaim = `${file}.reclaim`;
    let guard;
    try { guard = await open(reclaim, "wx", 0o600); }
    catch (error) { if (error.code === "EEXIST") throw new Error("Run lock recovery is already in progress; inspect run.lock.reclaim if its owner crashed."); throw error; }
    try {
      const { pid } = JSON.parse(await readFile(file, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid run lock; inspect it before recovery.");
      try { process.kill(pid, 0); }
      catch (probe) {
        if (probe.code !== "ESRCH") throw probe;
        await unlink(file);
        return await acquire();
      }
      throw new Error("This acceptance directory is still owned by a running process.");
    } finally { await guard.close(); await unlink(reclaim); }
  }
}

export async function savePartialEvidence(repository, output, status, answer) {
  if (answer) await writeFile(path.join(output, "answer.md"), answer + "\n", "utf8");
  const projects = (await repository.listProjects()).filter((item) => item.mode === "conversation");
  const project = status.projectId ? projects.find((item) => item.projectId === status.projectId) : projects[0];
  if (!project) return;
  const snapshot = await repository.exportProject(project.projectId);
  await writeJsonAtomic(path.join(output, "snapshot.json"), snapshot);
  status.projectId = project.projectId;
  status.budget = snapshot.budget;
  return snapshot;
}

export async function runAcceptanceTurn(client, status, prompt, signal, save) {
  // Persist intent before creation: a crash before its acknowledgement must
  // attempt resume, never silently create over a possibly persisted session.
  if (status.sessionCreated || status.sessionCreationStarted) await client.resume(status.sessionId, signal);
  else {
    status.sessionCreationStarted = true;
    await save();
    await client.createSession(status.sessionId, signal);
    status.sessionCreated = true;
    await save();
  }
  await client.prompt(status.sessionId, status.attempt > 1
    ? `继续当前会话中尚未完成的研究。先核对已有研究、正文读取、引用和检查点，复用已保存的材料，不新建研究、不重复已完成工作、不重置或扩充预算。若预算已耗尽，说明并停止。原始任务：\n${prompt}`
    : prompt, signal);
  await client.wait(status.sessionId, signal);
}
