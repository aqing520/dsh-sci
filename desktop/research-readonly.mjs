function esc(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

function readOnlyClient() {
  const api = window.researchApi, notice = document.getElementById("notice");
  const node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
  document.getElementById("refresh").onclick = async () => { try { location.href = await api.refresh(); } catch (error) { notice.textContent = String(error); } };
  document.getElementById("projects").addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]"); if (!button) return;
    const card = button.closest(".project"), projectId = card.dataset.project, output = card.querySelector(".output");
    button.disabled = true; notice.textContent = "";
    try {
      if (button.dataset.action === "report") {
        const context = await api.reportReviewContext({ projectId });
        output.replaceChildren(node("p", "报告状态：" + context.status), node("pre", context.report.markdown));
        for (const warning of [...context.warnings, ...context.blockers]) output.append(node("p", warning));
      } else {
        const snapshot = await api.exportProject(projectId);
        if (button.dataset.action === "records") output.replaceChildren(node("pre", JSON.stringify(snapshot, null, 2)));
        else {
          output.replaceChildren(node("h4", "已保存文献"));
          if (!snapshot.sources.length) output.append(node("p", "暂无已保存文献。"));
          for (const source of snapshot.sources) {
            const section = node("section"); section.append(node("h4", source.title));
            const versions = (snapshot.sourceContents ?? []).filter((content) => content.sourceId === source.sourceId);
            if (!versions.length) { section.append(node("p", "尚无可预览正文。")); output.append(section); continue; }
            const select = node("select"); select.setAttribute("aria-label", "正文版本");
            for (const version of versions) { const option = node("option", version.contentVersionId); option.value = version.contentVersionId; option.selected = version.contentVersionId === source.latestContentVersionId; select.append(option); }
            const preview = node("button", "预览正文"), more = node("button", "下一段"), text = node("pre"); more.hidden = true;
            let nextOffset;
            const load = async (offset) => {
              preview.disabled = true; more.disabled = true;
              try {
                const result = await api.previewSource({ projectId, sourceId: source.sourceId, contentVersionId: select.value, offset, limit: 2 });
                text.textContent = result.chunks.map((chunk) => chunk.text).join("\n\n");
                nextOffset = result.nextOffset; more.hidden = nextOffset === undefined;
              } catch (error) { notice.textContent = String(error); }
              finally { preview.disabled = false; more.disabled = false; }
            };
            preview.onclick = () => load(0); more.onclick = () => load(nextOffset);
            select.onchange = () => { text.textContent = ""; more.hidden = true; };
            section.append(select, preview, more, text); output.append(section);
          }
        }
      }
    } catch (error) { notice.textContent = String(error); }
    finally { button.disabled = false; }
  });
}

export function renderReadOnlyResearchDashboard({ projects = [] } = {}) {
  const rows = projects.map((project) => `<article class="project" data-project="${esc(project.projectId)}"><h3>${esc(project.title)}</h3><p>${esc(project.question)}</p><p>${esc(project.status)}</p><button data-action="records">查看计划与证据记录</button><button data-action="sources">预览文献</button><button data-action="report">查看已有报告</button><div class="output" aria-live="polite"></div></article>`).join("");
  return `<!doctype html><html lang="zh-CN" data-research-access="read-only"><meta charset="utf-8"><title>Research Workspace (Read Only)</title><style>body{font:14px system-ui;margin:24px;background:#f5f7fa;color:#1f2937}.project{background:white;border:1px solid #d7dde5;border-radius:8px;padding:16px;margin:12px 0}button,select{font:inherit;padding:7px;margin:4px;border:1px solid #b9c2cc;border-radius:6px;background:white}pre,p,h3{white-space:pre-wrap;overflow-wrap:anywhere}pre{max-height:500px;overflow:auto;background:#f7f8fa;padding:12px}#notice{color:#93291f}</style><header><h2>研究工作区 · 只读</h2><p>可查看计划、文献和已有报告。修改与审批请使用常规研究工作区。</p><button id="refresh">刷新</button></header><p id="notice" role="alert"></p><main id="projects">${rows || "<p>暂无研究项目。</p>"}</main><script>(${readOnlyClient.toString()})();</script></html>`;
}
