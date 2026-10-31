# 科研 Agent 验收记录

日期：2026-10-30。此记录区分功能回归、真实 provider 检查和发布环境验收；不以本地 stub 或单元测试替代真实研究质量验收。

| 检查 | 当前证据 | 结果 / 范围 |
| --- | --- | --- |
| 跨计划 DSH 会话恢复边界 | [最终回归](../research/validation/final-session-scope-tests-20261030.txt)、[SDK smoke](../research/validation/session-binding-full-tests-20261030.txt)、[材料修订复盘](../research/validation/material-revision-summary-20261030.md) | `runResearchWithDshAgent`、生产 Electron runner 和案例恢复脚本均使用按计划持久化的 SDK session；旧项目级指针保留，新计划使用 `agent-sessions/<planId>.json`，同计划重启恢复、跨计划创建新 session。最终回归 414 项（412 通过、2 Windows symlink 权限跳过、0 失败），构建和合成 SDK smoke 通过。真实 provider 重试仍因 `UND_ERR_SOCKET` 失败，主案例未新增 claims/evidence、未执行实验 |
| 长假设/设计的无损分页读取与修订草案 | [本轮证据](../research/validation/candidate-detail-20261030/summary.json)、[接口说明](research-hypothesis-design.md#agent-完整读取已有候选)、[主案例修订草案](../research/validation/imputation-revision-draft-20261030.md) | 构建通过；完整回归 413 项（411 通过、2 Windows symlink 权限跳过、0 失败）。明文/加密、字段白名单、项目范围和只读 bridge 通过；对真实暂停案例的 2 个候选共 27 个字段逐页还原，快照与前次预审完全一致。草案明确主方向、oracle/估计器区别、证据候选和跨缺失率依赖；未入研究仓库、未调用模型、未修改预算或审批，科研质量待审 |
| 明确授权后的候选行为测试 | [真实运行](../research/validation/cases/imputation-tests-1793367740427/behavior-run-20261030/summary.json)、[授权记录](../research/validation/cases/imputation-tests-1793367740427/behavior-run-20261030/authorization.json) | 用户批准具体不可变提案后由正常内核执行；exitCode 0、completed、184 ms，7 个文件哈希未变。只完成行为测试项目；未运行完整模拟/runner 输出验证，未通过科研质量验收 |
| 主案例文献/设计开发者预审 | [预审材料](../research/validation/source-design-audit-20261030/review.md) | 5 条发现、5 段保存正文逐字定位；发现缺主张证据关系及人审、比较相关性不足、假设方向/证伪条件与跨缺失率依赖需澄清。原主案例未变；不是人审、批准或实验结论 |
| 隔离案例工作区 | [本轮证据](../research/validation/case-workspace-20261030/summary.json)、[实际 Electron 只读 smoke](../research/validation/cases/imputation-tests-1793367740427/workspace-smoke-20261030-v2/summary.json)、[入口说明](research-case-workspace.md) | 新增 5 项回归；全量复验 409 项（407 通过、2 Windows symlink 权限跳过、0 失败），构建和 58 文件 package smoke 通过。真实待审批案例 7 个文件已渲染，三个只读写接口拒绝，快照未变、0 批准、0 执行。初次全量 Windows 内存探测失败后独立/全量复验通过；实际启动 argv 问题已修正。未执行候选，未进行完整 release preflight 或主案例科研验收 |
| 局部代码修订、bootstrap v2 与测试审批检查点 | [本轮汇总](../research/validation/focused-revision-20261030/summary.json)、[404 项回归](../research/validation/focused-revision-full-tests-20261030.txt)、[测试审阅包](../research/validation/cases/imputation-tests-1793367740427/review-packet-1793367771971/review.md) | 构建、404 项（402 通过、2 Windows symlink 权限跳过、0 失败）、SDK 引用纠正及 56 文件 package smoke 通过。局部继承权限/完整合并限额和 v1/v2 独立数值/旧记录兼容已验证；真实模型仍有漏检，operator 修正后另行真实静态复核。最新 7 文件/1 审查、0 候选执行；无 blocker 报告不等于正确性。新行为测试提案绑定具体哈希，任务 waiting-approval、无 approval、0 运行；完整科研闭环尚未通过 |
| 结果引用纠正与持久化次数限制 | [最终全量回归](../research/validation/result-reference-full-tests-final-20261030.txt)、[9 项专项](../research/validation/result-reference-bound-tests-20261030.txt)、[官方 SDK 引用纠正](../research/validation/result-reference-sdk-final-20261030.txt)、[身份纠正回归](../research/validation/result-reference-identity-regression-20261030.txt) | 构建、397 项（395 通过、2 Windows symlink 权限跳过、0 失败）、56 文件 package smoke 通过；合成 SDK 3 次上游尝试与产品账本一致、一次纠正、一次任务完成。真实修订保存完整协议但因 360 秒截止失败；独立候选审查另留证。不是科研质量或完整 preflight 验收 |
| 完整协议候选的独立真实静态审查 | [真实 SDK 审查](../research/validation/code-review-live-1793364876457/summary.json)、[独立 RNG 标量核对](../research/validation/result-reference-independent-rng-20261030.json) | 4 次真实请求、76,535 已报告 token、6 文件完整读取、1 份审查及结果提交通过；0 实验，原案例未改写。没有触发结果纠正，不能证明真实模型纠错能力。候选测试断言仍有错误且被模型漏检，不能算代码正确或科研验收 |
| 代码准备契约、来源补线与真实推进 | [本轮证据](../research/validation/research-code-preparation-20261030/summary.json) | 构建通过；371 项完整回归（370 通过、1 Windows symlink 权限跳过），最后阅读重试指引后 40 项专项及 SDK smoke 通过。真实代码探针 2 次请求保存完整候选模块、0 执行。完整新规划案例仍因文献超时/跨尝试阅读门槛失败，历史重放最多完成 T1—T4；没有科研质量批准或实验结果 |
| W10 决策与重新规划可靠性 | [W10 证据包](../research/validation/w10-decision-recovery-20261030-141310/summary.json) / [恢复协议](research-decision-recovery.md) | 构建、66 项专项、295 项完整回归（294 通过、1 项 Windows 符号链接权限跳过）、SDK 与真实 Electron Workspace smoke 通过；跨实例并发、计划/评估摘要绑定、过期规划拒绝、预算暂停、手动迭代日志、无计划失败恢复、明文/加密写入前后故障和真实子进程退出恢复已验证。真实主案例尚无实验/评估/决策，W10/W13 科研及发布验收仍未完成 |
| 完整 `release:preflight` 历史基线 | [历史报告](../research/validation/release-preflight-1793295006418.json)，2026-10-29T17:31:29.764Z 返回 `ok: true` | 构建、116 项测试（115 通过、1 跳过）、Harness/SDK/Workspace/应用崩溃/package smoke、恢复审计、语法和 diff 检查通过；发生在下列协议/预算改动之前 |
| P1.5 产品模型预算当前自动化回归 | [模型预算记录](../research/validation/research-model-budget-1793300491685.json) | 构建、166 项测试（165 通过、1 跳过）、五类 smoke、34 文件 package、案例协议/语法/diff 通过；SDK 2 次上游尝试与 2 次产品预留一致，15 项新增行为测试包括真实子进程退出及凭据过滤。P1.6 真实科研复验另行留证 |
| P1 结果身份/日志恢复前轮自动化回归 | [验证记录](../research/validation/research-result-protocol-1793298974897.json) | 构建、151 项测试（150 通过、1 跳过）、Harness/SDK/Workspace/完整应用崩溃/32 文件 package 五类 smoke、案例协议/语法/diff 通过；包括七处写入故障、真实子进程退出的明文/加密恢复、重复与迟到结果拒绝。不是完整 preflight 或真实科研验收 |
| P1 协议/预算前轮回归 | [历史验证记录](../research/validation/research-protocol-budget-1793297587849.json) | 131 项测试（130 通过、1 跳过）、SDK/真实 Electron Workspace 预算表单、31 文件 package smoke 等通过；结果身份/日志恢复改动前的历史记录 |
| P1.6 真实科研复验与预算核对 | [第三次运行](../research/validation/cases/imputation-v1-1793300481509/summary.json) / [计量核对](../research/validation/cases/imputation-v1-1793300481509/budget-reconciliation.json) | 新模型计划 10 步，完成 3 项结构任务后 token 阈值暂停；产品与代理均 23 次请求、1,053,593 token、1 次 unknown，重建后直接恢复拒绝；三份 v2 结果收据有效。引用未核验，无实验/评估/报告/记忆，完整科研质量未通过 |
| P0 真实科研基线 | [首次](../research/validation/cases/imputation-v1-1793295714130/summary.json) / [重放](../research/validation/cases/imputation-v1-1793296073188/summary.json) | 分别完成 0/5 任务，17/32 次真实请求，均 failed；无实验运行/评估/报告/记忆，引用未审阅，通用搜索未配置；P0 基线已取得，科研闭环未通过 |
| 审批队列 | `test/research-review.test.ts` + Electron Workspace smoke | 跨项目队列、任务与实验分别授权、并发启动拒绝、重启读取和旧计划提案拒绝已验证 |
| W06 设计质量审阅 | [W06 证据包](../research/validation/w06-design-review-20261030-0452/summary.json) | 5 项专项、212 项完整回归（211 通过、1 跳过）、Electron Workspace smoke、设计哈希/计划/假设绑定、过期审阅和 Agent bridge 拒绝写入通过；真实主案例科研质量仍为 `not-reviewed` |
| SDK 超时边界复验 | [imputation-v1-1793330067307](../research/validation/cases/imputation-v1-1793330067307/summary.json) | 213 项完整回归（213 通过、1 跳过）和 Workspace smoke 通过；T2 真实来源任务仍因 120 秒 DSH operation timeout 失败，但超时后 SDK 子进程/bridge 已关闭，未继续写入旧轮次；11 来源、6 引用、6 claims，未进入实验/评估/报告/记忆，科研质量保持 `not-reviewed` |
| T1—T5 真实主案例推进 | [imputation-v1-1793331405069](../research/validation/cases/imputation-v1-1793331405069/summary.json) | T1 计划、T2 三个独立来源与逐字引用、T3 可证伪假设、T4 候选设计已完成；T5 在 Workspace 审批门等待，未自动执行实验；3 来源、3 引用、3 claims，科研质量保持 `not-reviewed` |

### 补充可访问来源并保留历史案例

冻结协议中的来源提示可能遇到验证码。可以对新案例提供补充 HTTPS 地址，不改写协议或历史案例：

```text
node scripts/research-case-live.mjs --source-hint https://ekja.org/journal/view.php?doi=10.4097/kjae.2013.64.5.402
node scripts/research-case-live.mjs --plan-from research/validation/cases/imputation-v1-1793354437755/plan.json --source-hint https://ekja.org/journal/view.php?doi=10.4097/kjae.2013.64.5.402
```

`--source-hint` 最多重复五次；禁止带凭据的地址。每次运行新建案例目录，在 question、plan、`supplementalSourceHintsOperatorSupplied` 和 `operatorActions` 中保留新增线索及其人工提供属性。重放只复用已有模型计划的任务，不沿用任务完成状态、来源或批准。实验协议哈希保持不变；输入配置版本变为 3，不能作为与旧案例相同输入的自主检索表现比较，也不授权研究审批或实验执行。

已通过出版社正文读取探针和 NCBI 标识映射确认：`PMC3668100` 对应 DOI `10.4097/kjae.2013.64.5.402`，出版社正文可访问。证据见 [可访问版本核对](../research/validation/publisher-access-1793355518378/summary.json)及 [NCBI 标识映射](../research/validation/publisher-access-1793355518378/identifier-mapping.json)。该探针不产生 Agent 阅读回执，不代表引文支持性或科研质量通过。

### 审批后继续执行

运行结束后可以先导出人工审阅检查点：

```text
npm run research:case:review -- --case research/validation/cases/<case-directory>
```

每次在案例下新建 `review-packet-<timestamp>/review.md` 和 `review.json`，不覆盖旧包。包内包含正文片段、按保存内容重新核对的引文定位、Agent 阅读回执、输入线索来源、候选假设/设计及完整暂存代码和哈希。代码只从该案例 workspace 内读取并核对字节/哈希，文件变化时拒绝导出。它要求案例已有结束记录，并在导出前后核对 Repository 快照；这不是跨进程快照锁，请先停止写入者。检查点不创建研究报告、不修改科研状态、不写人工审阅或批准。

**独立代码准备任务**：新计划使用显式 `code-preparation` 类型，完成契约要求当前计划/当前任务的真实 `codeBundle`，并只开放 `code-stage`、artifact 和记录类动作。仍要求当前运行任务、已保存的动作权限和项目 workspace；旧计划的权限和契约不会自动扩权。Agent 只能暂存候选文件，不能批准或执行，论文阅读任务也不因此获得代码暂存能力。`npm run research:code:live` 是一个真实模型单任务探针：已验证 2 次请求保存完整 `randomization.mjs`、真实 bundle 哈希和 0 次实验运行；它不代表主案例或科学质量通过。真实案例 `imputation-v1-1793356293946` 保留 T5 两次超时失败证据；此前 `imputation-v1-1793355640516` 保留修复前权限阻塞证据。

`scripts/research-case-resume.mjs` 已加入。默认模式只读取现有案例并输出审批检查点；传入 `--run` 才会在所有当前任务审批已由 Workspace 完成后恢复标准 DSH runner。该脚本不调用任何批准方法，也不直接写入批准字段；未完成审批时会明确停止并列出任务、设计、代码包和提案哈希。示例：

恢复脚本现在以 `sessionScope: "plan"` 运行：每个计划使用独立的 SDK session 指针，旧项目级 session 只用于兼容历史调用，不会被新计划覆盖。

`--run` 在加载 provider 或启动 SDK 前会检查持久化墙钟、请求/token 上限和 `exhausted` 标记；过期案例只输出检查点并拒绝启动，避免在没有新授权预算时消耗请求。

新增离线续跑准备入口：

```text
npm run research:case:prepare-resume -- --case research/validation/cases/<case-directory> --write
```

该入口只读取权威案例 repository 和已保存的 `proposed-plan-input.json`，校验前三个任务类型/依赖、冻结协议哈希，并输出 proposal/snapshot 哈希、失败任务、预算和科研产物计数。它不会调用模型、创建计划、改变审批或启动实验；如果已有任务耗尽尝试，会明确要求通过新计划提交流程继续，并保留旧失败记录。当前主案例的输出见 [`offline-resume-preparation-1793374255503.json`](../research/validation/cases/imputation-v1-1793358639679/offline-resume-preparation-1793374255503.json)。

在用户已授权继续开发后，已将该提案通过离线 plan-commit 协议提交为新计划：

```text
npm run research:case:commit-offline-plan -- --case research/validation/cases/<case-directory>
# review the printed proposalSha256/sourcePlanId, then commit exactly that preview:
npm run research:case:commit-offline-plan -- --case research/validation/cases/<case-directory> --commit --expected-plan <sourcePlanId> --proposal-sha256 <proposalSha256> --write
```

当前主案例的新计划为 `07bb6424-8c99-487a-ae89-43138925b3f5`，旧计划 `8e99e758-5cf5-43c2-905e-b62c5cce775f` 保留为 `superseded`。默认命令只读预览；提交必须回显预览中的来源计划 ID和提案哈希，提案或计划发生变化会拒绝。提交只改变计划版本，不更新预算、不批准任务、不执行代码或实验；证据见 [`offline-plan-commit-1793375018160.json`](../research/validation/cases/imputation-v1-1793358639679/offline-plan-commit-1793375018160.json)。

```text
npm run research:case:resume -- --case research/validation/cases/<case-directory>
npm run research:case:resume -- --case research/validation/cases/<case-directory> --run
```

结构化迭代决策也已加入 Repository：`decisions/` 保存不可变的 `ResearchDecision`，记录评估 ID、停止规则、迭代上限、预算余量、未解决冲突和新计划 ID；报告会绑定这些决策并在上游哈希中纳入它们。真实主案例尚未产生决策，因此该案例的 W10 仍保持待验收。
| T1—T4 真实重放与安全代码包 | [imputation-v1-1793334031110](../research/validation/cases/imputation-v1-1793334031110/summary.json) | 重放冻结计划后完成 T1—T3，并生成安全相对文件名 `run.mjs` 的 7.8 KB 内容寻址代码包；设计与代码绑定哈希已保存，仍在可信 Workspace 设计/代码审批门，未执行命令或实验；3 来源、3 引用、4 claims、3 evidence，科研质量保持 `not-reviewed` |
| W09 配对评估内核 | `evaluatePairedBootstrap` + `checkIndependentNumericResult`；科研专项 47 项通过 | 固定种子/重采样次数/输入哈希/百分位区间/实践阈值已持久化到评价对象；样本少于 30（含 8 次控制）强制 `inconclusive` 并要求人工审阅；不代表主案例已产生实验数据 |
| W11 报告版本与人工审阅 | [W11 证据包](../research/validation/w11-report-quality-20261030-150351/summary.json) | 28 项专项、320 项全量回归（319 通过、1 跳过）、Electron Workspace smoke；报告绑定精确来源版本、run、artifact、evaluation、设计审阅和上游证据哈希；断链/无批准/失败或中断运行/统计待审/旧计划会阻止定稿，可信审阅与只读导出通过；真实主案例报告和独立科研质量仍待验收 |
| W12 记忆索引与检索记录 | [W12 证据包](../research/validation/w12-memory-20261030-155152/summary.json) | 13 项记忆专项、330 项全量回归（329 通过、1 跳过）、10/10 中文查询前五召回、Repository/SDK 重启后有界记忆注入和来源版本绑定通过；当前 `tokenfans.ai/codex` embedding 探针 HTTP 405，真实 embedding 尚未通过，W12 保持待验收 |
| W12 工作区入口与配置边界补验 | [增量证据](../research/validation/w12-workspace-20261030/summary.json) / [使用说明](research-memory.md) | 20 项相关专项、TypeScript 检查和实际 Electron Workspace smoke 通过；按所选项目重建、失败保留旧快照、适用范围/来源版本/警告展示与转义、进行中取消后队列释放、独立 embedding 配置及错误脱敏均验证。中文本地测试和真实探针共用固定查询集。未重复全量回归，未新增真实 embedding 调用；HTTP 405 与真实科研验收仍待解决 |
| W13 bridge 只读权限与安全审计历史增量 | [历史证据](../research/validation/w13-security-20261030/summary.json) | 11 项权限/审计专项、339 项全量回归（338 通过、1 跳过）、SDK/Harness/Electron Workspace smoke 通过；只读写动作拒绝、项目范围、角色伪造、未知输入脱敏、有界加密审计已验证。后续只读窗口和迁移状态以本表新增项为准 |
| W13 只读/迁移历史完整回归 | [356 项测试](../research/validation/w13-final-full-tests.txt) / [增量证据](../research/validation/w13-workspace-migration-20261030/summary.json) | 356 项（355 通过、1 Windows symlink 权限跳过、0 失败）；生产 Electron 权限、旧 Workspace、Harness 和 package smoke 通过。SDK smoke 首次与全量/窗口测试并行时失败且未留足根因；增加任务失败诊断后单独复跑通过，保留首次失败，原因未定位。未把此项记作持续稳定性已验收 |
| 完整协议新案例与挑战页修复 | [案例](../research/validation/cases/imputation-v1-1793354437755/summary.json) / [增量证据](../research/validation/w13-guard-network-20261030/summary.json) | 11 项真实模型计划；完成 T1，T2 因第三来源是 reCAPTCHA 挑战页明确 blocked，14 次真实请求全部 HTTP 200、3 来源/3 引用/4 主张，无实验/评估/报告/记忆。第三条引用只证明访问阻碍，不是科学证据。采集层新增明确挑战页拒绝，17 项专项及单次真实 PMC 采集拒绝留证；不改旧案例，不自动通过科研审阅 |
| W13 Harness guard 与网络诊断 | [增量证据](../research/validation/w13-guard-network-20261030/summary.json) | 最新 366 项完整回归（365 通过、1 跳过）、SDK、52 文件 package、真实 Harness native/PTC 默认两种配置通过；自动模式缺失 enforcement API 会拒绝启动，实际 Agent 的 scoped/未知/shell/写文件/run_code 直接及嵌套入口拒绝，工具体未执行，后续 allow 无法覆盖 guard。嵌套探针只调用 registry 入口；run_code 程序没有执行。代理脱敏记录区分连接/响应头、正文、超时及实际 HTTP 状态；69 项规划/协议/预算/插件相关回归通过。系统断网与独立安全审计不在通过范围 |
| 只读报告导出 | 读取前后报告数和 events.jsonl 内容对比 + preload IPC | 不重新生成报告、不写项目事件 |
| 动作审计 | 自动 Runner 的接受/拒绝动作及 30 条并发事件回归 | 已认证且能归属到现有项目的动作；不保存请求正文或密钥 |
| 真实 provider 连通 | 应用配置加载后的 ModelGateway 调用 | `tokenfans-codex` / `gpt-6.1-sol` 返回 `completed` |
| 真实 SDK 2 步预验收 | `research/validation/live-provider-1793293903182.json` | 两步完成；两次受控断连；SDK 重启后原 session 恢复 |
| 真实 SDK 20 步 | [真实端点报告](../research/validation/live-provider-1793293932837.json) | 20 次有效上游响应、2 次受控断连；10 步后重建 Repository/SDK 并恢复原会话；每项任务只有一个完成事件 |
| 完整 Electron 崩溃恢复 | [app-crash-1793294824588.json](../research/validation/app-crash-1793294824588.json) | 主进程 SIGKILL 后清理 10 个后代进程；重启暂停项目、保留证据/记忆、标记 interrupted、报告警告并阻止重复执行 |
| 最新 Electron 崩溃恢复复验 | [app-crash-1793334873660.json](../research/validation/app-crash-1793334873660.json) | 修正 smoke 使合成实验先经过代码/输入预览和精确审批；实际清理 10 个后代进程，恢复后保留证据/记忆、阻止重复执行并保留中断报告警告 |
| 结果协议变更后完整应用恢复复验 | [app-crash-1793298894399.json](../research/validation/app-crash-1793298894399.json) | Windows 开发版 SIGKILL/后代清理/暂停/证据记忆保留/interrupted/禁止直接重跑通过；仍不证明安装升级、断电或 Linux |
| 系统网络故障、版本升级继续运行 | 尚无本轮运行证据 | 待验收；loopback 故障注入不等同系统断网 |
| Linux 发布环境 | 先前 WSL2 启动出现 `ERROR_NO_SYSTEM_RESOURCES` | 尚未完成实机验证 |
| 人工完整科研案例 | 尚无完整证据包 | 待走通问题、计划、检索、假设、实验、评估、迭代、报告和跨会话记忆 |
| 多角色权限、独立安全审计 | [bridge 证据](../research/validation/w13-security-20261030/summary.json) / [生产主进程窗口测试](../research/validation/w13-readonly-access.json) | 只读 Workspace 与集中 IPC 权限已实现；35 个写入通道、伪造角色、未绑定窗口、替换文档和 popup 拒绝，正文预览/报告查看不改项目，拒绝审计和正常退出通过。子 frame 权限有单测；scoped/PTC Harness guard 见下方新增证据，独立安全评审仍待完成 |
| 离线研究数据迁移 | [迁移专项](../research/validation/w13-migration-tests.txt) / [操作说明](research-migration.md) | 11 项专项通过；明文/加密手写旧 fixture、项目索引损坏、源/备份哈希、保留旧预算/计划/报告门槛、六个中断边界与真实子进程退出重试、重复迁移、损坏/未来格式/错误密钥/junction 拒绝；未对用户数据执行迁移，安装版升级另行验收 |
| 新安装包 | 未运行 `dist:win` | 保留已有包；旧 0.2.1 包 warning 尚在；版本匹配不证明包含当前工作树 |

真实 provider 检查使用合成任务，验证可靠运行，不评价科研结论的正确性。完整研究案例还需评估检索覆盖、引用忠实度、实验设计和统计解释。

新增的实验 `planId` 是可选字段：新记录由内核绑定当前计划；旧记录继续兼容读取。上线前仍需结合升级样例验证历史实验的计划归属。
