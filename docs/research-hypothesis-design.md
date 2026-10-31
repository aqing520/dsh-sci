# 假设与实验设计协议

P3 把“模型说了一个假设”和“研究内核保存了可审阅、可执行的设计”分开。`ResearchHypothesis` 保存命题、适用范围、可观测预测、反驳条件、竞争解释，以及可选的主张和引文 ID。假设在当前计划和 hypothesis 任务中创建，字段内容计算 SHA-256；相同内容幂等返回同一 ID。修订必须提供前一假设 ID 和理由，旧版本进入 `superseded`。

`ResearchExperimentDesign` 保存数据说明与版本、实验单位、独立/因变量、对照、主次指标、重复数、随机化、缺失值处理、分析方法和停止规则。设计引用假设的内容哈希，因而能检测假设变更。设计任务只能用 design ID 完成，命令式 experiment definition 不能替代设计。设计候选默认为 `draft`，只有可信 Workspace IPC 可以使用打开时的 `contentHash` 批准；Agent bridge 没有审批动作。

研究流程中依赖设计任务的实验必须带 `designId`。创建和执行前会重新检查当前计划、设计状态、假设内容哈希以及是否有更新版本。假设或设计被修订后，旧版本失效，原实验不能继续执行。没有设计流程的旧独立命令实验继续使用原有显式执行审批，不会自动获得设计记录。

W07 已加入版本化代码暂存、代码/输入 manifest、提案哈希和独立的可信内容审批；执行前及启动前重新核对绑定。批准设计与批准命令/代码/输入是两个操作，前者不自动产生后者。W07 的专项、完整回归和 Workspace/SDK/Harness/package smoke 已通过，脱敏证据见 [`w07-code-binding-20261030-043345/summary.json`](../research/validation/w07-code-binding-20261030-043345/summary.json)。旧独立实验的兼容路径也已覆盖；真实主案例、独立复现和科研质量仍待验，详见[实施计划执行卡](research-agent-implementation-plan.md#从当前工作树开始的执行卡)。字段非空只证明结构存在，可证伪性和分析方法是否合理仍须独立审阅。创建/审批/修订的多文件写入未纳入结果提交 journal；状态读取同时检查 supersedes 关系，不能把普通调用去重当作断电事务保证。

Workspace 的“假设与实验设计”面板显示版本状态、绑定假设、设计字段和失效提示，并提供带内容哈希的设计审批入口。该面板只负责可信人工审阅，不能替 Agent 读取来源或代替实验运行。

## Agent 完整读取已有候选

`research_action` 的 `inspect` 清单只返回假设或设计的摘要；不能用截断摘要修订旧候选。先读取 `collection: "hypotheses"` 或 `"experimentDesigns"`，取得 `recordId`、`contentHash` 和 `detailFields`，再按字段读取：

```json
{"action":"inspect","collection":"hypotheses","recordId":"<清单中的 recordId>","field":"predictions","offset":0,"limit":1}
```

详情页的 schema 是 `dsh-sci.research-candidate-detail.v1`。`offset` 表示分片编号，每片最多 2000 个 JavaScript UTF-16 代码单元；`limit` 默认为 1，最大为 3。按 `nextOffset` 继续读取，将全部页的 `entries[].text` 按 `index` 拼接后再 `JSON.parse`，可恢复原字符串、数组或绑定对象。不要逐片解析 JSON，也不要将分片当作完整预测条目。字段不存在时 `present: false`、`total: 0`；空字符串与空数组仍以 JSON 表示，可以区分。

每页返回原候选 `contentHash`、计划和状态。跨页核对 `recordId` / `contentHash`；发生变化就重新读取。`currentPlan: false` 表示历史候选；读取它不会恢复旧计划效力。只接受该清单列出的字段，不能借此读取任意对象属性或其他项目记录。

详情读取适用于只读 bridge，不保存来源/代码阅读回执，不修改候选或审批。修订仍须在正常的新计划/当前有效任务流程中提交 `supersedesHypothesisId` 或 `supersedesDesignId` 及 `changeReason`，重新绑定新假设哈希；分页读取不会代替预算、质量或执行审批。

设计质量审阅为独立 `dsh-sci.research-design-review.v1` 记录，保存可检验性、分析单位、对照、主指标、重复数依据、方法适用性和停止规则七项判断。`accepted` 要求七项均通过并有说明；`changes-requested` / `insufficient` 允许记录未通过项。它绑定 designId/planId/contentHash，设计修订后旧记录过期。质量审阅不自动批准执行，版本审批也不等于质量通过。Agent bridge 无写入入口；真实主案例质量仍需用户或指定研究审阅者核查，合成表单回归不代替科研审阅。

这些检查证明协议与权限边界，不能证明某个科研结论正确。完整主案例还需要真实来源人工核查、获批实验、独立复现、统计适用性审阅和报告审阅。
