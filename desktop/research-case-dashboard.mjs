function escape(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

function client() {
  const api = window.researchCaseApi, root = document.getElementById("case"), notice = document.getElementById("notice");
  const readOnly = document.documentElement.dataset.access === "read-only";
  const previews = new Map();
  const node = (tag, text) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; return value; };
  const details = (label, value) => { const item = node("details"); item.append(node("summary", label), node("pre", typeof value === "string" ? value : JSON.stringify(value, null, 2))); return item; };
  function button(label, action, disabled = false) {
    const b = node("button", label); b.disabled = disabled || readOnly;
    b.onclick = async () => { b.disabled = true; notice.textContent = "处理中…"; try { await action(); notice.textContent = "操作已记录"; await refresh(); } catch (error) { notice.textContent = String(error); b.disabled = disabled || readOnly; } };
    return b;
  }
  async function refresh() {
    const projects = await api.list();
    if (projects.length !== 1) throw new Error("Expected one selected case");
    const snapshot = await api.exportProject(projects[0].projectId), projectId = snapshot.project.projectId;
    root.replaceChildren(node("h2", snapshot.project.title), node("p", "状态：" + snapshot.project.status + " · 实际运行：" + snapshot.experimentRuns.length));
    root.append(details("研究问题与范围", snapshot.project.question), details("材料来源与开发者介入记录", snapshot.caseProvenance));
    const tasks = node("section"); tasks.append(node("h2", "任务授权"));
    for (const task of snapshot.plan?.tasks ?? []) {
      const row = node("article"); row.append(node("h3", task.title), node("p", task.taskId + " · " + task.status), node("p", task.objective));
      if (task.status === "waiting-approval") row.append(button("批准此任务（不执行）", () => api.approveTask({ projectId, taskId: task.taskId, planId: snapshot.project.planId })));
      tasks.append(row);
    }
    root.append(tasks);
    for (const experiment of snapshot.experiments) {
      const article = node("article"), key = experiment.experimentId + "/" + experiment.proposalContentHash;
      article.dataset.experiment = experiment.experimentId;
      article.append(node("h2", experiment.title), node("p", "提案 SHA-256：" + experiment.proposalContentHash), details("命令、输入、输出及批准记录", experiment));
      const input = { projectId, experimentId: experiment.experimentId, contentHash: experiment.proposalContentHash };
      const preview = node("button", "查看完整代码和输入");
      preview.onclick = async () => { preview.disabled = true; try { const result = await api.review(input); previews.set(key, result); await refresh(); notice.textContent = "已载入全部绑定文件，请逐项展开审阅"; } catch (error) { previews.delete(key); notice.textContent = String(error); preview.disabled = false; } };
      article.append(preview);
      const reviewed = previews.get(key);
      if (reviewed) for (const file of reviewed.files) { const item = details(file.kind + " · " + file.relativePath + " · SHA-256 " + file.sha256, file.text); item.className = "bound-file"; article.append(item); }
      const task = snapshot.plan?.tasks.find((item) => item.taskId === experiment.taskId);
      const alreadyRun = snapshot.experimentRuns.some((run) => run.experimentId === experiment.experimentId);
      const executableTask = !experiment.taskId || !task?.requiresApproval || ["running", "completed"].includes(task?.status);
      if (!experiment.approval) article.append(button("批准此版本（不执行）", () => api.approveExperiment(input), !reviewed || !executableTask || alreadyRun));
      article.append(button("执行已批准的提案", () => api.execute({ ...input, approved: true }), !reviewed || !experiment.approval || !executableTask || alreadyRun));
      root.append(article);
    }
    root.append(details("真实运行记录、输出及错误", snapshot.experimentRuns), details("假设、设计及静态审查", { hypotheses: snapshot.hypotheses, designs: snapshot.experimentDesigns, reviews: snapshot.codeReviews }));
    document.documentElement.dataset.ready = "true";
  }
  document.getElementById("refresh").onclick = () => refresh().catch((error) => { notice.textContent = String(error); });
  refresh().catch((error) => { notice.textContent = String(error); });
}

export function renderCaseDashboard({ directory, readOnly = true }) {
  return `<!doctype html><html lang="zh-CN" data-access="${readOnly ? "read-only" : "owner"}"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'"><title>科研案例审阅</title><style>body{font:16px system-ui;max-width:1050px;margin:30px auto;padding:0 24px;color:#172534;background:#f5f7f9}article,section{background:white;border:1px solid #d5dee5;padding:18px;margin:18px 0;border-radius:10px}button{padding:10px 16px;margin:8px 12px 8px 0;cursor:pointer}button:disabled{cursor:default}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px Consolas,monospace}summary{cursor:pointer;padding:10px 0}#notice{white-space:pre-wrap;color:#903d12}h1{font-size:26px}</style></head><body><h1>科研案例审阅 · ${readOnly ? "只读" : "可审批"}</h1><p>${escape(directory)}</p><p>打开与查看材料不会执行代码。任务授权、具体版本批准和执行分别操作；测试案例的批准仅适用于该测试提案。</p><button id="refresh">刷新状态</button><p id="notice" role="status"></p><main id="case"></main><script>(${client.toString()})()</script></body></html>`;
}
