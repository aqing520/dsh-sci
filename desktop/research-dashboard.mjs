import { renderReadOnlyResearchDashboard } from "./research-readonly.mjs";

function esc(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

function researchDashboardClient() {
  const api = window.researchApi;
  const main = document.getElementById("projects");
  const notice = document.getElementById("notice");
  const node = (tag, text, className) => { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
  const error = (value) => { notice.textContent = String(value); notice.hidden = false; };
  const load = async () => { location.href = await api.refresh(); };
  const readOnlyButton = node("button", "打开只读窗口"); readOnlyButton.type = "button";
  readOnlyButton.onclick = async () => { try { await api.openReadOnly(); } catch (value) { error(value); } };
  document.querySelector("header").append(readOnlyButton);
  const auditButton = node("button", "查看安全审计"); auditButton.type = "button"; auditButton.id = "security-audit";
  const auditOutput = node("pre", undefined, "security-audit-output"); auditOutput.id = "security-audit-output"; auditOutput.hidden = true;
  document.querySelector("header").append(auditButton); document.querySelector("header").after(auditOutput);
  auditButton.addEventListener("click", async () => { auditButton.disabled = true; try { const audits = await api.listSecurityAudits(200); auditOutput.hidden = false; auditOutput.textContent = audits.length ? audits.map((audit) => `${audit.at} · ${audit.outcome} · ${audit.action}${audit.reason ? ` · ${audit.reason}` : ""}${audit.projectId ? ` · project=${audit.projectId}` : ""}`).join("\n") : "暂无安全审计记录。"; } catch (value) { error(value); } finally { auditButton.disabled = false; } });
  const details = (card, value) => { const pre = card.querySelector(".details"); pre.hidden = false; pre.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2); };
  const download = (id, content, type, extension) => { const url = URL.createObjectURL(new Blob([content], { type })); const anchor = node("a"); anchor.href = url; anchor.download = "research-" + id + extension; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  async function renderBudget(card, saved = false) {
    const projectId = card.dataset.project;
    const budget = await api.readBudget(projectId);
    let panel = card.querySelector(".budget-panel");
    if (!panel) { panel = node("section", undefined, "budget-panel"); card.append(panel); }
    panel.replaceChildren(node("h4", "研究预算"), node("p", budget ? "已预留任务执行：" + budget.usedTaskExecutions + " / " + budget.maxTaskExecutions + "；首次执行：" + (budget.startedAt ?? "尚未开始") : "旧项目尚未配置预算，请明确设置后再自动执行。"));
    panel.append(node("p", "总时间从首次执行起计算，包含暂停和退出时间；重试消耗任务执行次数。修改额度前先取消正在运行的 Agent，保存后再单独恢复。"));
    const metered = budget?.schema === "dsh-sci.research-budget.v2";
    panel.append(node("p", metered ? "模型请求预留：" + budget.usedModelRequests + " / " + budget.maxModelRequests + "；已报告 token：" + budget.reportedTotalTokens + " / " + budget.maxModelTokens + "（输入 " + budget.reportedInputTokens + "，输出 " + budget.reportedOutputTokens + "）；未知用量：" + budget.unknownUsageRequests + " 次；待结算：" + budget.modelRequests.filter((request) => request.status === "reserved").length + " 次。" : "旧预算缺少模型额度，请明确设置后继续。历史模型用量未计量。"));
    if (budget?.unmeteredHistory) panel.append(node("p", "升级前的模型使用量未计量；此处数字仅包含新预算配置后的调用。"));
    panel.append(node("p", "每次网络尝试前预留请求次数；重试也计次，中断后不自动退还。Token 仅按服务返回的 usage 累计，达到阈值停止后续调用，不能精确封顶；搜索、OCR、embedding 另计。"));
    const form = node("form", undefined, "budget-form");
    const executionsLabel = node("label", "任务执行次数上限 ");
    const executions = node("input"); executions.type = "number"; executions.name = "maxTaskExecutions"; executions.min = String(Math.max(1, budget?.usedTaskExecutions ?? 0)); executions.max = "10000"; executions.step = "1"; executions.required = true; executions.value = String(budget?.maxTaskExecutions ?? 100); executionsLabel.append(executions);
    const secondsLabel = node("label", " 总时间上限（秒，含暂停） ");
    const seconds = node("input"); seconds.type = "number"; seconds.name = "maxWallTimeSeconds"; seconds.min = "0.001"; seconds.max = "604800"; seconds.step = "0.001"; seconds.required = true; seconds.value = String((budget?.maxWallTimeMs ?? 3600000) / 1000); secondsLabel.append(seconds);
    const submit = node("button", "保存预算", "primary"); submit.type = "submit";
    const requestsLabel = node("label", " 模型请求次数上限 ");
    const requests = node("input"); requests.type = "number"; requests.name = "maxModelRequests"; requests.min = String(Math.max(1, metered ? budget.usedModelRequests : 0)); requests.max = "10000"; requests.step = "1"; requests.required = true; requests.value = String(metered ? budget.maxModelRequests : 100); requestsLabel.append(requests);
    const tokensLabel = node("label", " 已报告 Token 停止阈值 ");
    const tokens = node("input"); tokens.type = "number"; tokens.name = "maxModelTokens"; tokens.min = String(Math.max(1, metered ? budget.reportedTotalTokens : 0)); tokens.max = "100000000"; tokens.step = "1"; tokens.required = true; tokens.value = String(metered ? budget.maxModelTokens : 1000000); tokensLabel.append(tokens);
    form.append(executionsLabel, secondsLabel, requestsLabel, tokensLabel, submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); notice.hidden = true; submit.disabled = true;
      try { await api.updateBudget({ projectId, limits: { maxTaskExecutions: Number(executions.value), maxWallTimeMs: Math.round(Number(seconds.value) * 1000), maxModelRequests: Number(requests.value), maxModelTokens: Number(tokens.value) } }); await renderBudget(card, true); }
      catch (value) { error(value); }
      finally { submit.disabled = false; }
    });
    panel.append(form);
    if (saved) panel.append(node("p", "预算已保存，已用次数和首次执行时间保留；项目不会自动恢复。"));
  }
  async function renderDesigns(card) {
    const projectId = card.dataset.project;
    const snapshot = await api.exportProject(projectId);
    let panel = card.querySelector(".designs-panel");
    if (!panel) { panel = node("section", undefined, "designs-panel"); card.append(panel); }
    panel.replaceChildren(node("h4", "假设与实验设计"), node("p", "检查可观测预测、反驳条件、对照、指标和停止规则。批准设计后仍需单独批准实验执行。"));
    for (const hypothesis of snapshot.hypotheses ?? []) {
      const entry = node("article", undefined, "hypothesis-entry memory-entry");
      entry.append(node("h5", hypothesis.proposition), node("small", hypothesis.hypothesisId + " · " + hypothesis.status), node("p", "适用范围：" + hypothesis.scope));
      for (const [label, values] of [["预测", hypothesis.predictions], ["反驳条件", hypothesis.falsifiers], ["竞争解释", hypothesis.alternativeExplanations]]) entry.append(node("p", label + "：" + values.join("；")));
      if (hypothesis.changeReason) entry.append(node("p", "修订理由：" + hypothesis.changeReason));
      panel.append(entry);
    }
    if (!snapshot.hypotheses?.length) panel.append(node("p", "尚无结构化假设。"));
    for (const design of snapshot.experimentDesigns ?? []) {
      const entry = node("article", undefined, "design-entry memory-entry"); entry.dataset.designId = design.designId;
      entry.append(node("h5", "实验设计 · " + design.status), node("small", design.designId), node("p", "绑定假设：" + design.hypothesisIds.join("、")));
      const pre = node("pre", JSON.stringify({ dataDescription: design.dataDescription, dataVersion: design.dataVersion, dataRefs: design.dataRefs, experimentalUnit: design.experimentalUnit, independentVariables: design.independentVariables, dependentVariables: design.dependentVariables, controls: design.controls, primaryMetric: design.primaryMetric, secondaryMetrics: design.secondaryMetrics, repetitions: design.repetitions, randomization: design.randomization, missingDataHandling: design.missingDataHandling, analysisMethod: design.analysisMethod, stoppingRule: design.stoppingRule, randomSeed: design.randomSeed, supersedesDesignId: design.supersedesDesignId, changeReason: design.changeReason, contentHash: design.contentHash }, null, 2));
      entry.append(pre);
      const stale = design.planId !== snapshot.project.planId || design.status === "superseded" || snapshot.experimentDesigns.some((candidate) => candidate.supersedesDesignId === design.designId)
        || design.hypothesisBindings.some((binding) => !snapshot.hypotheses.some((h) => h.hypothesisId === binding.hypothesisId && h.planId === design.planId && h.contentHash === binding.contentHash && !["superseded", "rejected"].includes(h.status)) || snapshot.hypotheses.some((candidate) => candidate.supersedesHypothesisId === binding.hypothesisId));
      const priorReviews = (snapshot.designReviews ?? []).filter((review) => review.designId === design.designId).sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt));
      for (const review of priorReviews.slice(-2)) entry.append(node("small", "质量审阅：" + review.status + (!stale && review.planId === design.planId && review.designContentHash === design.contentHash ? "" : "（已过期）") + " · " + review.note));
      const reviewForm = node("form", undefined, "design-review-form");
      const criteria = [["hypothesisTestable", "假设可检验"], ["analysisUnitMatchesDesign", "分析单位匹配"], ["controlsAndComparisonAreAdequate", "对照与比较充分"], ["primaryMetricPreSpecified", "主指标预先规定"], ["repetitionCountJustified", "重复数有依据"], ["analysisMethodAppropriate", "分析方法适用"], ["stoppingRulePreSpecified", "停止规则预先规定"]];
      const checks = {};
      for (const [key, label] of criteria) { const item = node("label"); const checkbox = node("input"); checkbox.type = "checkbox"; checkbox.name = key; checks[key] = checkbox; item.append(checkbox, label); reviewForm.append(item); }
      const reviewStatus = node("select"); reviewStatus.name = "status"; for (const [value, label] of [["accepted", "审阅通过"], ["changes-requested", "要求修改"], ["insufficient", "证据不足"]]) reviewStatus.append(Object.assign(node("option", label), { value }));
      const reviewNote = node("textarea"); reviewNote.name = "note"; reviewNote.required = true; reviewNote.placeholder = "说明分析单位、样本量、方法适用性和需要修改的依据";
      const reviewSave = node("button", "保存设计质量审阅"); reviewSave.type = "submit"; reviewSave.disabled = stale; reviewForm.append(reviewStatus, reviewNote, reviewSave);
      reviewForm.onsubmit = async (event) => { event.preventDefault(); reviewSave.disabled = true; try { await api.reviewExperimentDesign({ projectId, designId: design.designId, contentHash: design.contentHash, status: reviewStatus.value, note: reviewNote.value, criteria: Object.fromEntries(criteria.map(([key]) => [key, checks[key].checked])) }); await renderDesigns(card); } catch (value) { error(value); } finally { reviewSave.disabled = stale; } };
      entry.append(reviewForm);
      if (stale) entry.append(node("p", "计划、设计或绑定假设已变更或失效，请在当前计划修订设计后重新审阅和审批。"));
      if (design.status === "draft" && design.planId === snapshot.project.planId) {
        const approve = node("button", "批准此设计", "primary"); approve.type = "button"; approve.className += " approve-design"; approve.disabled = stale;
        approve.onclick = async () => { approve.disabled = true; try { await api.approveExperimentDesign({ projectId, designId: design.designId, contentHash: design.contentHash }); await renderDesigns(card); } catch (value) { error(value); approve.disabled = false; } };
        entry.append(approve);
      }
      const experiments = snapshot.experiments.filter((experiment) => experiment.designId === design.designId);
      entry.append(node("p", "关联实验：" + (experiments.map((experiment) => experiment.experimentId).join("、") || "尚无")));
      panel.append(entry);
    }
    if (!snapshot.experimentDesigns?.length) panel.append(node("p", "尚无实验设计。命令提案不能替代实验设计。"));
    if (snapshot.codeReviews?.length) {
      panel.append(node("h4", "Agent 代码静态检查"), node("p", "以下是候选检查结果，尚待人工审阅。保存检查结果不会批准代码或实验，也不证明测试已运行。"));
      for (const review of snapshot.codeReviews) {
        const entry = node("article", undefined, "code-review-entry");
        entry.append(node("h5", review.codeReviewId), node("p", review.summary), node("small", "代码包：" + review.bundleId + " · " + review.status));
        entry.append(node("pre", JSON.stringify({ bundleContentHash: review.bundleContentHash, designBinding: review.designBinding, files: review.files, findings: review.findings, limitations: review.limitations, scientificQuality: review.scientificQuality }, null, 2), "details"));
        panel.append(entry);
      }
    }
  }
  async function renderSources(card) {
    const projectId = card.dataset.project;
    const snapshot = await api.exportProject(projectId);
    let panel = card.querySelector(".sources-panel");
    if (!panel) { panel = node("section", undefined, "sources-panel"); card.append(panel); }
    panel.replaceChildren(node("h4", "文献、原文与证据审阅"), node("p", "获取内容、Agent 读取和人工支持性核查分别记录。此处浏览不会替 Agent 完成阅读任务。"));
    const searchForm = node("form", undefined, "source-search-form");
    const query = node("input"); query.name = "query"; query.placeholder = "研究检索词"; query.required = true; query.maxLength = 1000;
    const search = node("button", "检索来源"); search.type = "submit";
    const backend = node("select"); backend.name = "backend";
    for (const [value, label] of [["auto", "已配置搜索；未配置时使用 Crossref"], ["crossref", "Crossref 学术元数据"], ["configured", "仅使用已配置搜索服务"]]) { const option = node("option", label); option.value = value; backend.append(option); }
    searchForm.append(query, backend, search); panel.append(searchForm);
    searchForm.onsubmit = async (event) => { event.preventDefault(); search.disabled = true; try { await api.search({ projectId, query: query.value, backend: backend.value }); await renderSources(card); } catch (value) { error(value); } finally { search.disabled = false; } };
    panel.append(node("p", "查询记录：" + (snapshot.searchLogs?.length ?? 0) + "；当前检索适配器只返回第一页，尚不支持翻页。"));
    for (const log of (snapshot.searchLogs ?? []).slice(-10)) panel.append(node("small", log.query + " · " + log.provider + " · " + log.status + (log.failureKind ? " · " + log.failureKind : "")));
    const referenceForm = node("form", undefined, "reference-form");
    const reference = node("input"); reference.name = "reference"; reference.required = true; reference.placeholder = "DOI、arXiv 或网页 URL";
    const acquire = node("button", "获取指定文献"); acquire.type = "submit"; referenceForm.append(reference, acquire); panel.append(referenceForm);
    referenceForm.onsubmit = async (event) => { event.preventDefault(); acquire.disabled = true; try { await api.resolveReference({ projectId, reference: reference.value }); await renderSources(card); } catch (value) { error(value); } finally { acquire.disabled = false; } };
    const relationPanel = node("section", undefined, "source-relations");
    relationPanel.append(node("h4", "来源关系与独立性"), node("p", "预印本、正式版、修正版和复现实验必须由人工明确关系；默认不把同一工作计为独立证据。"));
    const relationForm = node("form", undefined, "source-relation-form");
    const from = node("select"); from.name = "fromSourceId"; const to = node("select"); to.name = "toSourceId";
    for (const source of snapshot.sources) { from.append(Object.assign(node("option", source.title), { value: source.sourceId })); to.append(Object.assign(node("option", source.title), { value: source.sourceId })); }
    const kind = node("select"); kind.name = "kind";
    for (const [value, label] of [["same-work", "同一工作"], ["preprint-of", "预印本属于"], ["version-of", "版本属于"], ["replication-of", "复现此来源"], ["correction-of", "修正此来源"], ["related", "相关但不同"]]) kind.append(Object.assign(node("option", label), { value }));
    const independentLabel = node("label", "计为独立来源 "); const independent = node("input"); independent.type = "checkbox"; independent.name = "countsAsIndependent"; independentLabel.append(independent);
    const note = node("input"); note.name = "note"; note.required = true; note.maxLength = 4000; note.placeholder = "说明判断依据";
    const saveRelation = node("button", "保存来源关系"); saveRelation.type = "submit";
    relationForm.append(from, to, kind, independentLabel, note, saveRelation); relationPanel.append(relationForm);
    relationForm.onsubmit = async (event) => { event.preventDefault(); saveRelation.disabled = true; try { await api.relateSources({ projectId, fromSourceId: from.value, toSourceId: to.value, kind: kind.value, countsAsIndependent: independent.checked, note: note.value }); await renderSources(card); } catch (value) { error(value); } finally { saveRelation.disabled = false; } };
    for (const relation of (snapshot.sourceRelations ?? [])) relationPanel.append(node("small", `${relation.kind} · ${relation.fromSourceId} → ${relation.toSourceId} · ${relation.countsAsIndependent ? "独立" : "不独立"} · ${relation.note}`));
    panel.append(relationPanel);
    for (const source of snapshot.sources) {
      const section = node("article", undefined, "source-entry memory-entry"); section.dataset.sourceId = source.sourceId;
      section.append(node("h5", source.title), node("small", source.url ?? source.sourceId), node("p", "Agent 阅读状态：" + (source.reading?.status ?? "discovered") + " · 最近获取方式：" + (source.provenance?.kind ?? "unknown")));
      const versions = (snapshot.sourceContents ?? []).filter((content) => content.sourceId === source.sourceId);
      if (!versions.length) section.append(node("p", "尚无可定位正文/摘要；搜索摘要和手填摘录仅作线索。"));
      else {
        const select = node("select"); select.className = "content-version";
        for (const version of versions) { const option = node("option", version.scope + " · " + version.characters + " 字符" + (version.truncated ? " · 已截断" : "") + " · " + version.contentVersionId); option.value = version.contentVersionId; option.selected = version.contentVersionId === source.latestContentVersionId; select.append(option); }
        const open = node("button", "查看保存的原文"); open.type = "button"; open.className = "read-source";
        const output = node("div", undefined, "source-body"); section.append(select, open, output);
        const read = async (offset) => {
          const result = await api.readSource({ projectId, sourceId: source.sourceId, contentVersionId: select.value, offset, limit: 2 });
          output.replaceChildren(node("small", result.content.scope + (result.content.truncated ? " · 内容不完整" : "") + " · " + result.content.contentHash));
          for (const chunk of result.chunks) { output.append(node("small", (chunk.page ? "第 " + chunk.page + " 页 · " : "") + chunk.chunkId + " · 字符 " + chunk.startOffset + "–" + chunk.endOffset), node("pre", chunk.text, "details source-text")); }
          if (result.nextOffset !== undefined) { const next = node("button", "下一组原文"); next.type = "button"; next.className = "read-next"; next.onclick = async () => { try { await read(result.nextOffset); } catch (value) { error(value); } }; output.append(next); }
        };
        open.onclick = async () => { open.disabled = true; try { await read(0); } catch (value) { error(value); } finally { open.disabled = false; } };
      }
      panel.append(section);
    }
    panel.append(node("h4", "主张与引用支持关系"));
    for (const link of snapshot.evidence.filter((link) => link.sourceId)) {
      const section = node("article", undefined, "evidence-entry memory-entry"); section.dataset.evidenceId = link.evidenceId;
      const claim = snapshot.claims.find((claim) => claim.claimId === link.claimId);
      section.append(node("p", claim?.text ?? "主张记录缺失"), node("small", "模型提出关系：" + link.relation));
      if (!link.citationId) section.append(node("p", "尚未绑定具体引文，需补充 claim/evidence/citation 关系后审阅。"));
      else {
        const open = node("button", "核查引用与主张"); open.type = "button"; open.className = "open-evidence-review"; section.append(open);
        open.onclick = async () => {
          open.disabled = true;
          try {
            const context = await api.evidenceReviewContext({ projectId, evidenceId: link.evidenceId });
            const existing = section.querySelector(".evidence-review-form"); existing?.remove();
            const form = node("form", undefined, "evidence-review-form");
            form.append(node("p", "引文：" + (context.citation.quotedText ?? "无")), node("small", "内容版本：" + context.content.contentVersionId + " · 原文核验：" + context.verification.status));
            const locator = context.citation.locator;
            const index = context.content.chunkIndex.findIndex((chunk) => typeof locator === "object" && ((!locator.chunkId || chunk.chunkId === locator.chunkId) && (locator.page === undefined || chunk.page === locator.page) && (locator.startOffset === undefined || chunk.endOffset > locator.startOffset)));
            if (index >= 0) {
              const body = await api.readSource({ projectId, sourceId: context.citation.sourceId, contentVersionId: context.content.contentVersionId, offset: index, limit: 3 });
              for (const chunk of body.chunks) form.append(node("small", (chunk.page ? "第 " + chunk.page + " 页 · " : "") + chunk.chunkId), node("pre", chunk.text, "details source-text"));
            }
            const latest = context.reviews.slice().sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))[0];
            if (latest) form.append(node("p", "最近人工审阅：" + latest.status + (latest.current ? "" : "（内容或主张已变，需重审）") + " · " + latest.note));
            const status = node("select"); status.name = "status";
            for (const [value, label] of [["insufficient", "证据不足"], ["supported", "支持这条主张"], ["refuted", "反驳这条主张"], ["rejected", "拒绝此引用关系"]]) { const option = node("option", label); option.value = value; if (value === "accepted" && !context.canAccept) option.disabled = true; status.append(option); }
            const note = node("textarea"); note.name = "note"; note.required = true; note.maxLength = 4000; note.placeholder = "说明原文如何支持、反驳或不足以判断这条主张";
            const save = node("button", "保存人工审阅"); save.type = "submit";
            form.append(status, note, save);
            form.onsubmit = async (event) => { event.preventDefault(); save.disabled = true; try { await api.reviewEvidence({ projectId, evidenceId: link.evidenceId, binding: context.binding, status: status.value, note: note.value }); section.append(node("p", "人工审阅已保存：" + status.value, "evidence-review-saved")); } catch (value) { error(value); } finally { save.disabled = false; } };
            section.append(form);
          } catch (value) { error(value); } finally { open.disabled = false; }
        };
      }
      panel.append(section);
    }
  }
  async function renderApprovals() {
    const panel = document.getElementById("approval-results");
    const projectId = document.getElementById("approval-project").value;
    const taskFilter = document.getElementById("approval-task").value.trim().toLowerCase();
    const items = (await api.listApprovalQueue()).filter((item) => (!projectId || item.project.projectId === projectId) && (!taskFilter || [item.task?.taskId, item.task?.title, item.kind === "experiment" ? item.experiment.taskId : ""].some((value) => String(value ?? "").toLowerCase().includes(taskFilter))));
    panel.replaceChildren(node("p", "待审批：" + items.length + " 项"));
    for (const item of items) {
      const article = node("article", undefined, "memory-entry");
      const isTask = item.kind === "task";
      let contentReviewed = isTask || !(item.experiment.codeManifest?.length || item.experiment.inputManifest?.length);
      const cannotApprove = () => item.project.status === "paused" || item.project.status === "failed" || (!isTask && (item.task?.requiresApproval && !["running", "completed"].includes(item.task.status) || !contentReviewed));
      if (!isTask) article.dataset.experiment = item.experiment.experimentId;
      article.append(node("h4", (isTask ? "任务：" + item.task.title : "实验：" + item.experiment.title)), node("small", "项目：" + item.project.title + " · " + item.project.projectId), node("small", "任务：" + (item.task?.taskId ?? item.experiment?.taskId ?? "未关联")));
      if (isTask) article.append(node("p", item.task.summary ?? item.task.objective), node("small", "下一步：" + (item.task.nextAction ?? "等待人工批准")));
      else {
        const experiment = item.experiment;
        const preview = node("pre", JSON.stringify({ command: experiment.command, args: experiment.args, cwd: experiment.cwd, codeBundleId: experiment.codeBundleId, codeManifest: experiment.codeManifest, inputManifest: experiment.inputManifest, inputPaths: experiment.inputPaths, outputPaths: experiment.outputPaths, randomSeed: experiment.randomSeed, timeoutMs: experiment.timeoutMs, proposalContentHash: experiment.proposalContentHash, approval: experiment.approval }, null, 2), "details");
        article.append(preview, node("p", "批准后将按以上命令和输入执行，并保存运行结果。任务审批与实验执行分别授权。"));
        const review = node("button", "查看代码和输入内容", "review-experiment");
        review.type = "button";
        review.onclick = async () => {
          review.disabled = true;
          try {
            const result = await api.experimentReview({ projectId: item.project.projectId, experimentId: experiment.experimentId });
            if (result.proposalContentHash !== experiment.proposalContentHash) throw new Error("实验提案已变化，请刷新审批队列后重新查看。");
            const content = node("pre", result.files.map((file) => `[${file.kind}] ${file.relativePath} · ${file.sha256}\n${file.text}${file.truncated ? "\n[…内容已截断…]" : ""}`).join("\n\n") || "此命令没有声明代码或输入文件；内联代码见命令参数。", "details experiment-content");
            article.querySelector(".experiment-content")?.remove();
            article.append(content);
            contentReviewed = !result.files.some((file) => file.kind === "code" && file.truncated);
            if (!contentReviewed) article.append(node("p", "代码超过预览上限，请缩小代码提案后重新提交。"));
          } catch (value) { contentReviewed = false; error(value); } finally { review.disabled = false; approve.disabled = cannotApprove(); }
        };
        article.append(review);
      }
      const approve = node("button", isTask ? "批准此任务" : "批准并执行此实验", isTask ? "primary" : "primary approve-experiment");
      approve.type = "button";
      approve.disabled = cannotApprove();
      approve.onclick = async () => {
        approve.disabled = true;
        try {
          if (isTask) await api.approve({ projectId: item.project.projectId, taskId: item.task.taskId });
          else {
            if (item.experiment.proposalContentHash) await api.approveExperiment({ projectId: item.project.projectId, experimentId: item.experiment.experimentId, contentHash: item.experiment.proposalContentHash });
            const result = await api.executeExperiment({ projectId: item.project.projectId, experimentId: item.experiment.experimentId, approved: true });
            const output = document.getElementById("approval-run-result"); output.hidden = false; output.textContent = JSON.stringify(result, null, 2);
          }
          await renderApprovals();
        } catch (value) { error(value); approve.disabled = cannotApprove(); }
      };
      article.append(approve); panel.append(article);
    }
  }
  async function renderConflicts(card, editing) {
    const groups = await api.listMemoryConflicts(card.dataset.project);
    const panel = card.querySelector(".memory-panel");
    panel.replaceChildren(node("h4", editing ? "审阅记忆冲突" : "记忆冲突")); panel.hidden = false;
    if (!groups.length) { panel.append(node("p", "没有检测到冲突记忆")); return; }
    if (editing) {
      const batchForm = node("form", undefined, "memory-review-batch-form");
      const toolbar = node("div", undefined, "batch-review-toolbar");
      const selectLabel = node("label", "批量结论 "); const batchSelect = node("select"); batchSelect.name = "status";
      for (const [value, text] of [["unresolved", "待审阅"], ["accepted", "采用每组所选记忆"], ["ignored", "忽略所选组"], ["superseded", "所选组已被替代"]]) { const option = node("option", text); option.value = value; batchSelect.append(option); }
      selectLabel.append(batchSelect);
      const batchNoteLabel = node("label", "批量备注 "); const batchNote = node("input"); batchNote.type = "text"; batchNote.name = "note"; batchNote.maxLength = 4000; batchNote.placeholder = "可选，应用到所选冲突组"; batchNoteLabel.append(batchNote);
      const all = node("button", "全选冲突组"); all.type = "button"; all.dataset.action = "select-all-conflicts";
      const none = node("button", "取消全选"); none.type = "button"; none.dataset.action = "select-no-conflicts";
      const submit = node("button", "批量保存审阅", "primary"); submit.type = "submit";
      toolbar.append(selectLabel, batchNoteLabel, all, none, submit); batchForm.append(toolbar); panel.append(batchForm);
      all.onclick = () => { panel.querySelectorAll("input.batch-conflict").forEach((input) => { input.checked = true; }); };
      none.onclick = () => { panel.querySelectorAll("input.batch-conflict").forEach((input) => { input.checked = false; }); };
      batchForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const selectedGroups = [...panel.querySelectorAll("section.conflict-group")].filter((section) => section.querySelector("input.batch-conflict")?.checked);
        if (!selectedGroups.length) { error("请至少选择一个冲突组，再保存批量审阅。"); return; }
        const reviews = [];
        for (const section of selectedGroups) {
          const selected = section.querySelector('input[name="selectedMemoryId"]:checked');
          if (batchSelect.value === "accepted" && !selected) { error("批量采用时，每个选中的冲突组都必须选择一条记忆。"); return; }
          reviews.push({ conflictKey: section.dataset.conflictKey, status: batchSelect.value, selectedMemoryId: batchSelect.value === "accepted" ? selected.value : undefined, note: batchNote.value });
        }
        submit.disabled = true;
        try { await api.reviewMemoryConflictsBatch({ projectId: card.dataset.project, reviews }); await renderConflicts(card, true); } catch (value) { error(value); } finally { submit.disabled = false; }
      });
    }
    for (const [groupIndex, group] of groups.entries()) {
      const section = node("section", undefined, "conflict-group"); section.dataset.conflictKey = group.conflictKey;
      const heading = node("h5");
      if (editing) { const groupCheck = node("input"); groupCheck.type = "checkbox"; groupCheck.className = "batch-conflict"; groupCheck.checked = group.reviewStatus === "unresolved"; groupCheck.setAttribute("aria-label", "选择冲突组 " + group.conflictKey); heading.append(groupCheck, document.createTextNode(" ")); }
      heading.append(document.createTextNode(group.conflictKey));
      section.append(heading, node("p", "审阅状态：" + group.reviewStatus));
      const form = node("form", undefined, "memory-review-form"); const list = node("div", undefined, "conflict-entries");
      for (const entry of group.entries) {
        const label = node("label", undefined, "memory-entry");
        if (editing) { const radio = node("input"); radio.type = "radio"; radio.name = "selectedMemoryId"; radio.value = entry.memoryId; radio.checked = entry.review?.status === "accepted"; label.append(radio); }
        label.append(node("span", entry.text), node("small", "可信度：" + entry.confidence + " · " + (entry.review?.status ?? "unresolved")));
        if (entry.review?.note) label.append(node("small", "审阅备注：" + entry.review.note));
        if (entry.refs?.length) label.append(node("small", "来源引用：" + entry.refs.join(", ")));
        list.append(label);
      }
      form.append(list);
      if (editing) {
        const statusLabel = node("label", "审阅结论 "); const select = node("select"); select.name = "status";
        for (const [value, text] of [["unresolved", "待审阅"], ["accepted", "采用所选记忆"], ["ignored", "忽略整组"], ["superseded", "整组已被替代"]]) { const option = node("option", text); option.value = value; option.selected = value === group.reviewStatus; select.append(option); }
        statusLabel.append(select);
        const noteLabel = node("label", "审阅备注 "); const note = node("textarea"); note.name = "note"; note.maxLength = 4000; note.value = group.entries.find((entry) => entry.review?.note)?.review.note ?? ""; noteLabel.append(note);
        const submit = node("button", "保存审阅", "primary"); submit.type = "submit"; form.append(statusLabel, noteLabel, submit);
        form.addEventListener("submit", async (event) => { event.preventDefault(); const selected = form.querySelector('input[name="selectedMemoryId"]:checked'); if (select.value === "accepted" && !selected) { error("请选择要采用的记忆，再保存审阅。"); return; } submit.disabled = true; try { await api.reviewMemoryConflict({ projectId: card.dataset.project, conflictKey: group.conflictKey, status: select.value, selectedMemoryId: select.value === "accepted" ? selected.value : undefined, note: note.value }); await renderConflicts(card, true); } catch (value) { error(value); } finally { submit.disabled = false; } });
      }
      section.append(form); panel.append(section);
    }
  }
  async function renderReportReview(card) {
    const projectId = card.dataset.project;
    const context = await api.reportReviewContext({ projectId });
    const report = context.report;
    const reviews = context.reviews;
    const existing = card.querySelector(".report-review-panel"); existing?.remove();
    const panel = node("section", undefined, "report-review-panel memory-panel");
    panel.append(node("h4", "报告人工审阅"), node("small", "报告版本：" + report.reportId + " · 内容哈希：" + report.contentHash + " · 状态：" + context.status));
    if (context.blockers.length) panel.append(node("p", "定稿阻塞：" + context.blockers.join("；"), "notice"));
    const latest = reviews.slice().sort((a, b) => b.reviewedAt.localeCompare(a.reviewedAt))[0];
    if (latest) panel.append(node("p", "最近审阅：" + latest.status + (latest.current ? "（当前有效）" : "（已过期，需要重新生成报告）") + (latest.note ? " · " + latest.note : "")));
    const form = node("form", undefined, "report-review-form");
    const status = node("select"); status.name = "status";
    for (const [value, label] of [["accepted", "接受为定稿"], ["changes-requested", "要求修改"], ["rejected", "拒绝此报告"]]) { const option = node("option", label); option.value = value; if (value === "accepted" && !context.canAccept) option.disabled = true; status.append(option); }
    status.value = context.canAccept ? "accepted" : "changes-requested";
    const note = node("textarea"); note.name = "note"; note.required = true; note.maxLength = 4000; note.placeholder = "记录来源、实验、评估和限制的审阅意见";
    const save = node("button", "保存报告审阅", "primary"); save.type = "submit"; save.disabled = context.stale;
    form.append(status, note, save);
    form.onsubmit = async (event) => { event.preventDefault(); save.disabled = true; try { const result = await api.reviewReport({ projectId, reportId: report.reportId, reportContentHash: report.contentHash, status: status.value, note: note.value }); await renderReportReview(card); card.querySelector(".report-review-panel").append(node("p", "已保存：" + result.status, "report-review-saved")); } catch (value) { error(value); } finally { save.disabled = context.stale; } };
    panel.append(form); card.append(panel);
  }
  document.getElementById("refresh").onclick = () => load().catch(error);
  document.getElementById("load-approvals").onclick = () => renderApprovals().catch(error);
  document.getElementById("approval-project").onchange = () => renderApprovals().catch(error);
  document.getElementById("approval-task").oninput = () => renderApprovals().catch(error);
  document.getElementById("create").onclick = async () => { const question = document.getElementById("question").value.trim(); if (!question) return; try { await api.create({ question }); await load(); } catch (value) { error(value); } };
  const memoryForm = document.getElementById("memory-search-form");
  const rebuild = node("button", "重建所选项目记忆索引"); rebuild.type = "button"; rebuild.id = "memory-index-rebuild";
  const indexStatus = node("p"); indexStatus.id = "memory-index-status"; indexStatus.setAttribute("role", "status");
  memoryForm.querySelector(".search-controls").append(rebuild); memoryForm.after(indexStatus);
  rebuild.addEventListener("click", async () => {
    const projectId = memoryForm.elements.projectId.value;
    if (!projectId) { indexStatus.textContent = "请先选择要重建索引的项目。"; return; }
    rebuild.disabled = true; notice.hidden = true; indexStatus.textContent = "正在重建记忆索引…";
    try {
      const index = await api.rebuildMemoryIndex(projectId);
      indexStatus.textContent = "索引已重建：" + index.entryIds.length + " 条记忆 · " + index.model + " · " + index.dimensions + " 维" + (index.provider === "local-hash" ? "（本地词法/哈希基线）" : "（语义向量服务）") + "。";
    } catch (value) { indexStatus.textContent = "索引重建失败，已保存的记忆和旧索引仍保留。"; error(value); }
    finally { rebuild.disabled = false; }
  });
  memoryForm.addEventListener("submit", async (event) => {
    event.preventDefault(); const form = event.currentTarget; const output = document.getElementById("memory-search-results"); const submit = form.querySelector('button[type="submit"]'); submit.disabled = true; notice.hidden = true;
    try {
      const hits = await api.searchMemory({ query: form.elements.query.value, projectId: form.elements.projectId.value || undefined, since: form.elements.since.value || undefined, until: form.elements.until.value || undefined, minConfidence: form.elements.minConfidence.value || undefined, limit: 20 });
      output.replaceChildren(node("p", "找到 " + hits.length + " 条研究记忆"));
      for (const hit of hits) {
        const entry = node("article", undefined, "memory-entry");
        entry.append(node("p", hit.entry.text), node("small", "可信度：" + hit.entry.confidence + " · 更新时间：" + hit.entry.updatedAt));
        entry.append(node("small", "适用范围：" + (hit.entry.applicability || "尚未记录"), "memory-applicability"));
        if (hit.entry.expiresAt) entry.append(node("small", "有效期至：" + hit.entry.expiresAt));
        if (hit.entry.refs?.length) entry.append(node("small", "来源引用：" + hit.entry.refs.join(", ")));
        for (const binding of hit.entry.sourceBindings ?? []) entry.append(node("small", "来源绑定：" + binding.refId + " · " + binding.kind + " · 版本：" + (binding.contentVersionId || "无正文版本") + " · 摘要：" + (binding.contentHash || "未绑定"), "memory-source-binding"));
        const warnings = node("ul", undefined, "memory-warnings");
        for (const warning of hit.warnings ?? []) warnings.append(node("li", warning));
        if (warnings.childNodes.length) entry.append(warnings);
        output.append(entry);
      }
    } catch (value) { output.replaceChildren(node("p", "检索失败，请检查服务配置后重试。")); error(value); }
    finally { submit.disabled = false; }
  });
  main.addEventListener("click", async (event) => { const button = event.target.closest("button[data-action]"); if (!button) return; const card = button.closest(".project"); const id = card.dataset.project; const action = button.dataset.action; notice.hidden = true; button.disabled = true; try { switch (action) { case "designs": await renderDesigns(card); return; case "sources": await renderSources(card); return; case "budget": await renderBudget(card); return; case "replan": await api.replan(id); break; case "run-agent": details(card, await api.runAgent({ projectId: id, maxSteps: 20 })); return; case "cancel-agent": details(card, await api.cancelAgent(id)); return; case "conflicts": await renderConflicts(card, false); return; case "review-conflicts": await renderConflicts(card, true); return; case "report-review": await renderReportReview(card); return; case "activate": await api.activate(id); break; case "start": await api.startNext(id); break; case "approve": case "complete": { const snapshot = await api.exportProject(id); const task = snapshot.plan?.tasks.find((item) => item.taskId === snapshot.project.activeTaskId); if (!task) throw new Error("没有当前任务"); if (action === "approve") await api.approve({ projectId: id, taskId: task.taskId }); else await api.complete({ projectId: id, taskId: task.taskId, outputRefs: [] }); break; } case "pause": await api.pause(id); break; case "resume": await api.resume(id); break; case "report": details(card, (await api.generateReport(id)).markdown); return; case "report-html": case "report-markdown": { const exported = await api.exportReport({ projectId: id }); download(id, action === "report-html" ? exported.html : exported.markdown, action === "report-html" ? "text/html" : "text/markdown", action === "report-html" ? ".html" : ".md"); return; } case "export": download(id, JSON.stringify(await api.exportProject(id), null, 2), "application/json", ".json"); return; case "open": details(card, await api.exportProject(id)); return; } await load(); } catch (value) { error(value); } finally { button.disabled = false; } });
}

export function renderResearchDashboard({ projects = [], readOnly = false } = {}) {
  if (readOnly) return renderReadOnlyResearchDashboard({ projects });
  const buttons = [["open", "查看计划"], ["designs", "假设与实验设计"], ["sources", "文献与证据审阅"], ["conflicts", "查看记忆冲突"], ["review-conflicts", "审阅记忆冲突"], ["run-agent", "用 DSH Agent 执行"], ["cancel-agent", "取消 Agent"], ["activate", "激活计划"], ["start", "启动下一任务"], ["approve", "审批当前任务"], ["complete", "完成当前任务"], ["report", "生成报告"], ["report-review", "审阅报告"], ["report-html", "导出已有 HTML 证据图"], ["report-markdown", "导出已有 Markdown 报告"], ["pause", "暂停"], ["resume", "恢复"], ["export", "导出 JSON"]];
  buttons.splice(3, 0, ["budget", "查看和设置预算"], ["replan", "重新规划"]);
  const rows = projects.map((project) => `<article class="project" data-project="${esc(project.projectId)}"><h3>${esc(project.title)}</h3><p>${esc(project.question)}</p><div><b>${esc(project.status)}</b> · iteration ${esc(project.iteration)} · <code>${esc(project.projectId)}</code></div>${project.lastError ? `<p class="notice">${esc(project.lastError)}</p>` : ""}${buttons.map(([action, label]) => `<button data-action="${action}"${action === "run-agent" ? ' class="primary"' : ""}>${label}</button>`).join("")}<section class="memory-panel" hidden></section><pre class="details" hidden></pre></article>`).join("");
  const projectOptions = projects.map((project) => `<option value="${esc(project.projectId)}">${esc(project.title)}</option>`).join("");
  const approvalPanel = `<section class="search-panel"><h3>研究审批队列</h3><div class="search-controls"><label>项目<select id="approval-project"><option value="">所有项目</option>${projectOptions}</select></label><label>任务<input id="approval-task" placeholder="任务 ID 或标题"></label><button id="load-approvals" type="button">加载待审批任务和实验</button></div><div id="approval-results" aria-live="polite"></div><pre id="approval-run-result" class="details" hidden></pre></section>`;
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Research Workspace</title><style>body{font:14px system-ui;margin:0;padding:24px;background:#f5f7fa;color:#1f2937}header,.search-controls,.batch-review-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:end;margin-bottom:18px}input,select,textarea{font:inherit;padding:8px;border:1px solid #c7ced8;border-radius:6px}header input{flex:1}button{font:inherit;margin:8px 6px 0 0;padding:7px 10px;border:1px solid #b9c2cc;border-radius:6px;background:#fff;cursor:pointer}button.primary{background:#315b99;color:white;border-color:#315b99}button:disabled{opacity:.6;cursor:wait}.project,.search-panel{background:white;border:1px solid #d7dde5;border-radius:8px;padding:16px;margin:12px 0}.project h3{margin:0 0 6px}.project p,.memory-entry span{white-space:pre-wrap;overflow-wrap:anywhere}.source-text{white-space:pre-wrap;overflow-wrap:anywhere}.sources-panel small{display:block;margin:6px 0}.source-entry h5{font-size:14px}.details{background:#f7f8fa;padding:12px;overflow:auto}.memory-panel{margin-top:16px}.conflict-group{border-top:1px solid #d7dde5;padding:12px 0}.conflict-group h5{font:inherit;font-weight:bold;margin:8px 0}.memory-entry{display:block;padding:10px;margin:6px 0;border:1px solid #d7dde5;border-radius:6px}.memory-entry input{margin-right:8px}.memory-entry small{display:block;margin:5px 0;color:#596475;overflow-wrap:anywhere}.memory-review-form>label{display:block;margin:10px 0}.batch-review-toolbar{padding:10px;background:#f7f8fa;border:1px solid #d7dde5;border-radius:6px}.batch-review-toolbar label{display:flex;gap:4px;align-items:center}textarea{display:block;width:min(96%,600px)}.notice{padding:12px;background:#fff0ee;color:#93291f}.security-audit-output{white-space:pre-wrap;max-height:260px;overflow:auto;background:#f7f8fa;padding:12px;border:1px solid #d7dde5}</style><header><input id="question" aria-label="研究问题" placeholder="输入研究问题，创建一个可恢复的研究项目"><button class="primary" id="create">创建研究项目</button><button id="refresh">刷新</button></header><p id="notice" class="notice" role="alert" hidden></p><section class="search-panel"><h3>研究记忆检索</h3><form id="memory-search-form"><div class="search-controls"><label>关键词<input name="query" required></label><label>项目<select name="projectId"><option value="">所有项目</option>${projectOptions}</select></label><label>起始日期<input name="since" type="date"></label><label>截止日期<input name="until" type="date"></label><label>最低可信度<select name="minConfidence"><option value="">不限</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label><button class="primary" type="submit">搜索记忆</button></div></form><div id="memory-search-results" aria-live="polite"></div></section>${approvalPanel}<main id="projects">${rows || "<p>还没有研究项目。</p>"}</main><script>(${researchDashboardClient.toString()})();</script></html>`;
}
