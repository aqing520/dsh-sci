# 换设备开发交接与后续执行逻辑

日期：2026-11-03。仓库：<https://github.com/aqing520/dsh-sci>。

这是一份开发进度交接，当前改造尚未全部验收完成。Mac 接续改动见本文末尾的[接续记录](#mac-接续开发记录)。先读本文，再读[产品方向](research-native-agent-direction.md)和[实现与验证](research-conversation.md)。Rewind 的参考依据见[逆向分析报告](../research/rewind-analysis-report.md)。

## 不要偏离的产品目标

科研能力直接进入当前 DSH Agent 的工具、上下文和执行生命周期。用户在主对话提出问题，Agent 按需查资料、读正文、保存引用和证据、提出假设、准备实验并解释结果。使用当前会话的目录、模型和凭据。

不要要求用户先开独立科研工作区、建七阶段计划、启动另一个科研 Agent。现在的“研究记录”窗口是辅助审阅与历史入口。旧 external runner 保留兼容，但不是主对话科研能力的前提。

## 新设备启动

建议先在 Windows + Node.js 24 环境复现现有基线。本轮本机使用 Node.js 24.15.0；DSH 锁定依赖为 0.2.1-rc.2，Electron 为 44.7.0。先沿用 package-lock.json，不在迁移时顺手升级运行时依赖。

```powershell
git clone https://github.com/aqing520/dsh-sci.git
cd dsh-sci
git switch main
git pull --ff-only
npm ci
npm run build
npm test
npm run research:conversation:smoke
npm run package:smoke
npm run desktop
```

如果已有 checkout，先保留自己的本地改动，再拉取。提交图中会保留远端已有的项目删除、本地文档/目录导入、刷新和启动修复。

在应用 Models 设置里重新配置 TokenFans key。用户已明确选择用 TokenFans 的 Luna 做真实模型验收，不需要等 DeepSeek 官方 key；不要因此再询问相同授权。用户没有要求另加更低的测试预算，继续沿用应用已有默认预算和真实用量记录。

凭据、.env、本机配置、node_modules、dist、安装包、本地运行日志及 SDK session home 均不入 Git。新设备不会自动拥有旧机器的研究数据库。若要迁移真实研究和会话，需要另外安全迁移应用 userData（Windows 通常为 `%APPDATA%\dsh-sci`）；加密元数据还需要原 passphrase。不要把这些内容直接提交 GitHub。

## 已实施的主链路

| 位置 | 职责 |
| --- | --- |
| `desktop/dsh-sci-research-plugin.mjs` | native conversation 分支注册 21 个命名工具，注入上下文，接入 DSH approval 和预算生命周期；external runner 分支独立保留 |
| `src/research/conversation.ts` | 使用宿主真实 session ID + realpath workspace 绑定研究；限制项目和动作；保存 checkpoint、处理可信审批和预算 |
| `src/research/bridge.ts` | loopback bridge，普通 token 与审批 capability 分离；模型 JSON 不能伪造可信审批 |
| `src/research/orchestrator.ts` | 复用现有证据、代码、设计、实验和分析内核；按 project 缓存正确 workspace 的执行视图 |
| `src/research/repository.ts` | 研究仓储、加密/原子 metadata、conversation binding 和项目级 checkpoint |
| `src/capture.ts`、`desktop/dsh-sci-lifecycle-plugin.mjs` | 每 workspace 快照索引和 diff，按 session.cwd 取正确归属 |
| `desktop/brand/lib/client.js` | 官方 `tool.call.toolview` slot 中展开正文、引句、主张、证据关系、运行记录和产物；本地 fragment 引用定位 |
| `desktop/main.mjs`、`desktop/research-dashboard.mjs` | native bridge、目录观察、辅助研究记录界面；native 项目不再启动另一套 runner |

主对话采用一个连续的 conversation 任务身份记录收据，不强制走七阶段，不要求最终回答为 task-result JSON。`research_action` 是受限兼容接口，优先用命名工具。

已实现的关键约束：

- 没有全局 active-context fallback；另一个 session/workspace 不能借用本研究。
- `research_read` 返回真实正文和读取收据；`research_cite` 要求当前任务实际读过相应 chunk，原文引句必须连续匹配。获取文献不算阅读，精确匹配也不等于科学支持充分。
- 设计、代码 bundle、完整静态审查、具体执行审批和运行 manifest 分开记录。拒绝审批不执行；已完成提案重取已有 run，不重复运行。
- 反证分析保留原预测，不倒改假设来迎合结果。
- `agent/request` 预留、durable assistant 事件结算；缺 usage 记 unknown。停止边界等待结算落盘。新增 `llm/stream` hook 给 compaction 辅助模型调用记同一研究预算，不改变其路由和请求。
- `/research-status`、`/research-budget`、`/research-pause`、`/research-resume`、`/research-new`、`/research-adopt` 为人类命令入口，可在模型预算耗尽后使用；不自行清零已用额度。

## 这轮真实模型验收得到的事实

验收脚本是 `scripts/research-conversation-live.mjs`，会创建隔离目录、下载两篇真实论文的 PDF，使用生产插件和真实 DSH Agent。论文为 Attention Is All You Need（1706.03762v7）与 BERT（1810.04805v2）。任务要求比较注意力范围、训练目标、输入表征，以及 BLEU 和 GLUE 的可比性；每篇至少两条短引句，并保存主张、证据关系与 checkpoint。

TokenFans 实际观测：

1. `/codex` 下 gpt-6-luna 曾返回服务过载和 `no routable providers`；gpt-5.6-luna 尝试也未完成。
2. 同一个 key、同一个 gpt-6-luna，在 `https://tokenfans.ai/v1/responses` 的短请求成功，服务端报告 14 token；随后完整 Agent 请求也曾成功发出工具调用，但后续又遇到服务过载。短请求成功不能视为完整任务通过。
3. 一次真实 Luna 调用传入 `research_begin({newResearch:true,projectId:"",...})`，暴露了首次开启误走替换审批的问题；已修复为只有现有研究真的被替换才请求审批。
4. 同一次调用给可选的 source/reference/contentVersionId 传空字符串；`research_read` 的空版本号已归一为缺省，增加了真实调用形状的回归测试。
5. 修复后重试仍遭服务过载，**完整真实科研任务尚未验收通过**。应用里的 provider 配置没有被这轮隔离试验修改。

本机原始记录在 Git 忽略的 `research/validation/native-live-*/`，包含 status、PDF、隔离 Harness 日志等；不随这次提交上传。上面是可带到新设备的脱敏事实摘要。

## 后续执行顺序

### 1. 先确认迁移后的基线

运行上面的 build、test、native conversation smoke 和 package smoke。合成 smoke 只证明实际 DSH 工具链、引用落盘、自然语言回答和 Harness 重启恢复，不证明模型科研质量。

远端新合入了项目删除功能。继续开发时要检查它与新 session binding、pending 模型请求和运行中实验的兼容：删除不能留下无法恢复的当前绑定，也不能绕过运行生命周期。不要因为 merge 无冲突就认定语义已经验收。

### 2. 继续真实 Luna 文献用例

先确认服务当前可用。在新机器配置 key 后运行：

```powershell
npm run build
node scripts/research-conversation-live.mjs --live --model gpt-6-luna --base-url https://tokenfans.ai/v1 --output research/validation/native-live-luna-reading-next-device
```

该命令会消耗真实 API；输出目录必须不存在，防止覆盖已有验收。支持 `--credentials <本机凭据文件>`，默认读取当前 Windows 应用的凭据引用；不要把 key 放进命令行。脚本的 15 分钟是测试执行超时，应用默认研究预算仍保留。

原交接时脚本遇到错误只保存 status，尚无原地 resume；Mac 接续开发已补 `--resume --output`、部分 snapshot 和显式重试，使用方式与验证范围见本文末尾。继续用它观察真实中断恢复；不要把新建输出目录的全新运行算成“恢复成功”。首次模型选择研究前的调用不在研究项目预算中，如需覆盖全部验收费用，可由可信宿主预先绑定研究，或实际使用 `/research-new`，不能伪造追溯预留。

成功返回后逐项人工检查 `answer.md`、`snapshot.json`、正文 chunk 和引句：

- 两篇的相关正文确实进入模型上下文，不能只读摘要。
- 每篇至少两条定位准确的原文引用；引句确实支持相应主张。
- 区分 encoder 双向注意力、decoder 因果掩码和 cross-attention，避免把“Transformer”笼统等同于单向模型。
- BLEU 与 GLUE 来自不同任务、指标、数据和训练设定，不能据数值大小给出 BERT 全面更强的结论。
- 主张、证据关系和 checkpoint 已持久化，最终用自然中文解释限制。
- 继续同一 session 或新 Harness 后能恢复已有进度，不重复阅读和实验，不重置预算。

结构检查全绿以后仍需人工评估科学内容。脚本保留 `scientificReview: pending...` 正是为了不把结构通过误当科学验收。

### 3. 补真实桌面呈现验收

新证据卡片已做 React 渲染回归，但尚未在完整 DSH 桌面中逐项验收。确认插件 slot 真正加载、正文/引句可展开、fragment 引用能打开目标；长对话虚拟滚动或过程折叠时，目标可能不在当前 DOM，现实现不会自动从仓储加载缺失目标。若需要补定位，应走官方 session/slot 能力，不增加全局项目读取后门。

对话审批文本已改为具体设计字段、命令、argv、工作目录、输出、文件全文及 hash；通过 `[data-approval-scroll]` 保留换行。还需在真实 Electron 界面核对长代码能完整审阅，拒绝/允许结果与实际保存版本一致。现有 mock approval 测试和只读 IPC smoke 不足以替代这一步。

### 4. 完成长上下文与实验验收

原生 DSH 自带 compaction 能力；新增的辅助调用计量已有回归，但没有证明整段超长真实科研会话恢复正确。当前 research context 仍有 18000 字符裁剪，需验证 checkpoint、引用身份、冲突和下一步是否完整保留，避免仅截断 JSON 字符串造成残缺上下文。

当前安装版本的 pi-ai adapter 显式 `maxRetries: 0`，请求级重试由 DSH recovery 插件负责；不要重复实现另一套透明重试。检查实际 provider/插件组合的 durable 失败、重试、usage 和 unknown 记录，而不是声称任意 provider 的所有底层请求都已可见。

再跑一个真实的小型复现实验：预先保存预测、对照、输入和代码版本，经当前对话具体授权运行，核查 stdout、退出状态和输出 hash；加入反驳原预测的结果，再验证重启后不重复执行。已有算术 fixture 只证明机制，不代替科研实验质量。

### 5. 完成审计后再发布

按产品方向文档的全部场景逐项核验，包括目录/会话隔离、切模型与更新凭据、缺全文时的诚实报告、反证和中断恢复。运行对应回归与 release preflight，检查安装包与升级。当前这次上传是开发进度同步，不代表上述整套改造已经完成。

## 当前测试证据的范围

合并远端更新后重新验证：`npm run build` 通过；完整回归 438 项，436 通过、2 跳过、0 失败；native conversation smoke 和 package smoke 通过。smoke 使用真实 DSH Agent 与本地合成响应，完成 9 次模型调用，其中 8 次计入研究预算、64 个已报告 token，保存 2 次正文读取和 2 条匹配引用，Harness 重启后恢复且没有重复读取。package smoke 检查 59 个运行文件、4 条包含规则和 5 条敏感文件排除规则。

build 会清理 dist，一些测试又依赖 dist 中的脚本产物；必须先完成 build 再跑 test，不能把二者并发执行。原始测试输出在本地忽略目录，不把会话和凭据日志当源码上传。

新设备接手时可以直接把本文和产品方向文档交给开发 Agent，让它从“后续执行顺序”继续，并以当前代码和新测试输出为准。


## Mac 接续开发记录

本轮在 macOS arm64、Node.js 26.0.0 / npm 11.12.1 上安装锁定依赖继续开发，没有升级 `package-lock.json`。日常环境仍建议 Node.js 24；本轮结果不替代 Node.js 24 的独立验证。

### 已修改

- 真实 Luna 验收默认读取 macOS 的 `~/Library/Application Support/dsh-sci/harness/.credentials.yaml`；Windows 继续使用 `%APPDATA%\dsh-sci`。支持显式 `--credentials` 或 `TOKENFANS_API_KEY`，密钥不进入 prompt 和状态文件。
- 新运行的默认 endpoint 改为原交接中短请求曾成功的 `https://tokenfans.ai/v1`；恢复沿用保存的 endpoint 和模型，拒绝悄悄换路由。
- 新增 `--live --resume --output <原目录>`。恢复保留 SDK home、workspace、session ID、研究仓储和预算；每次尝试归档上次 status/snapshot/answer，失败或 SIGINT/SIGTERM 后关闭 SDK 并导出部分证据。SIGKILL/断电无法保证最后一批事件落盘。
- 同目录运行锁阻止并发验收；失效进程的锁可由显式恢复接管。若锁恢复过程本身被强制杀死，需先确认没有所有者再处理 `run.lock.reclaim`；不会自动绕过存活进程的锁。
- 保存 session 创建意图；创建确认前中断时优先恢复可能已落盘的 session，恢复失败不会静默另建会话。若宿主在真正创建前退出，需人工检查该次记录。
- 已下载论文逐项校验 hash，恢复不覆盖已记录的输入。现有预算耗尽后仍需明确的人类预算命令，脚本不会自动扩充额度或重启研究计时。十五分钟只限制每次验收进程。
- 修复实验 manifest 在 macOS `/var` 与 `/private/var` 别名下误报越界的问题。现有文件和缺失输出的父目录统一解析；指向工作区外的符号链接仍拒绝。
- 生命周期测试使用本机绝对路径，不再将 Windows 路径当作 Mac 路径；进程树内存与配额回归增加 darwin 覆盖。

新运行（会消耗真实额度）：

```sh
npm run build
node scripts/research-conversation-live.mjs --live --output research/validation/native-live-luna-mac
```

中断或失败后显式重试：

```sh
node scripts/research-conversation-live.mjs --live --resume --output research/validation/native-live-luna-mac
```

脚本不透明自动重试 provider 请求，仍由 DSH 自身 recovery 插件负责请求恢复。`--resume` 继续未完成研究，并非原样重放一次网络请求。已完成结构验收的目录拒绝重跑，科学审阅仍需人工完成。

### 验证与剩余工作

本轮已验证：

- `npm ci` 和 `npm run build` 成功；依赖锁文件未改动。
- `npm test`：444 项通过，0 失败、0 跳过，包括 Mac 进程树内存与配额、工作区别名和越界链接回归。
- `node scripts/research-conversation-smoke.mjs` 通过：在只读完两份材料、尚无引用的部分进度处关闭 Harness，同 session 重启后保存引用与 checkpoint；最终仍只有两次正文读取，预算从 3 次请求/24 token 累计到 8 次/64 token。
- `node scripts/package-smoke.mjs` 通过：59 个运行文件、4 条包含规则、5 条敏感文件排除规则。该检查不是安装包构建或启动验收。
- `git diff --check` 和验收脚本语法检查通过。
- Mac arm64 Electron 运行时已下载；`electron --no-sandbox --disable-gpu scripts/research-access-smoke.cjs` 通过。实际生产主进程、preload 和 IPC 的 owner/read-only/unbound 窗口验证成功，36 个写入通道的只读拒绝、非绑定窗口拒绝、替换文档拒绝、审计与正常退出均通过。该检查使用合成项目，不代替真实证据卡片与长代码审批的人工视觉验收。

合成 smoke 使用真实 DSH 循环和本地模型响应；本轮覆盖未完成研究的跨 Harness 恢复，不代表已完成真实 provider 过载或系统强杀后的全部恢复验收。

上轮迁移基线时尚未配置 Luna 凭据；用户随后已在应用设置中配置。真实调用与后续修复见下节。

Mac 与 Windows 共用源码；`node_modules`、应用数据和绝对路径绑定的会话不是跨系统可直接复用的产物。当前只配置 Windows NSIS 发布，macOS 安装包、签名、公证、真实桌面证据卡片与长代码审批仍待验收。

项目删除兼容与长上下文裁剪已在后续完善中增加保护和回归。真实小型复现实验、超长真实科研会话和完整桌面视觉验收仍需继续。


## 配置凭据后的接续完善

### 真实 Luna 调用事实

用户已通过 Mac 应用 Models 配置 TokenFans 凭据。本轮使用 `gpt-6-luna`、`https://tokenfans.ai/v1` 运行真实论文验收，凭据只在本机读取。

- 首次调用及一次 `--resume` 均返回服务过载：`Our servers are currently overloaded. Please try again later.`
- 两次使用同一输出目录 `research/validation/native-live-luna-mac-20261103`、同一 SDK session；第二次归档第一次 status 并恢复原 session，没有新建输出目录冒充恢复。
- 模型尚未创建研究项目，因此没有正文读取、引用或科学结论可供验收。未获得可报告 token usage，不据此推算费用。
- 未切换模型、重置预算或改写用户应用配置。该用例仍未通过，后续服务恢复后可对原目录显式 `--live --resume --output` 继续。

### 项目删除保护

`ResearchRepository` 增加按项目共享的写入队列，删除与项目文件持久化使用同一队列；项目索引更新另行排队，避免不同项目并发更新覆盖索引。

删除前检查未结算模型预留、`running` 实验和待恢复的计划/结果 journal，存在时拒绝删除。成功删除前先原子保存只含项目 ID 和时间的 `deleted-projects/<id>.json` 标记，再清理项目目录、会话绑定、旧 active-context 和索引。绑定和活动上下文读取会忽略已删项目；旧版本留下的指向缺失项目的会话绑定也视为未绑定。

标记保留用于拒绝重启后晚到的项目、预算、checkpoint、event 和绑定写入，不能通过重新保存同一 ID 复活项目。删除中断后可对同一 ID 重试清理；这不等于恢复被删除的研究内容。此队列覆盖当前桌面单写入进程的多 Repository 实例，并非跨进程数据库事务。原有全局研究记忆和历史捕获的保留规则未在本次改动中重写。

新增 `test/research-deletion.test.ts`：明文/加密下双会话解除绑定、同会话另开研究、重启后晚写拒绝、请求预留与删除竞态、实际实验取消后删除、并发保存另一项目时索引保留。

### 长上下文

生产科研插件不再 `JSON.stringify(research).slice(0, 18000)`。短上下文原样保留；超限时先选取研究身份、任务、checkpoint、预算和未解决记忆冲突 ID，再依次缩减可选记忆、近期证据与过长引用列表。缩短的正文和省略数量显式标记，提示使用 `research_context` / `research_inspect` 取回完整记录。

输出始终是完整 JSON，按序列化后的实际字符数限额，保留预算计数与耗尽原因，不修改工具返回的完整上下文缓存。若极端情况下连身份和最小摘要都超限，会明确报错，而非截断 JSON。新增超长研究、冲突记忆、检查点和 JSON 转义膨胀回归。它仍是有损摘要，超长真实模型科研会话尚未独立验收。

### 最新验证

- `npm run build` 通过。
- 全量 `npm test`：451 项通过，0 失败，0 跳过。
- 真实 DSH + 本地合成响应的 conversation smoke 通过，部分研究进度恢复后仍为 2 次读取、2 条匹配引用，累计 8 次研究模型请求 / 64 个已报告 token。
- Mac Electron production access smoke 通过，36 个只读写入通道拒绝、来源预览、窗口隔离、审计和正常退出均通过。
- package smoke 和 `git diff --check` 通过。
- 上一轮已补原生 `editMenu`，恢复 Mac 输入框的 Command 编辑快捷键；本轮不读取用户剪贴板或输出密钥。

下一步先在服务可用时完成同 session 的真实论文用例与科学内容审阅，再进行证据卡片/长代码审批的完整桌面人工验收、真实小型实验和超长会话恢复。不要因为本地 451 项回归通过就将这些验收标为完成。


## Sol 真实验收（用户授权切换后）

用户明确要求 Luna 不可用时改用 Sol。本轮以 `gpt-6.1-sol`、`https://tokenfans.ai/v1` 对相同的两篇 PDF 运行独立验收；保留 Luna 失败目录，不将更换模型后的新运行称为 Luna 恢复，也没有改写应用默认模型配置。

输出目录为 Git 忽略的 `research/validation/native-live-sol-mac-20261103`。原始 `status.json`、`snapshot.json`、`answer.md` 保留；额外复核在 `agent-review.json` / `review.md`，真实重启续接在 `restart-review.json` / `restart-answer.md`。

结果：

- 首次任务完成，7 项脚本结构检查全通过。2 个真实 PDF 来源，7 次 agent 正文读取，12 条精确匹配引用、8 条主张、11 条证据关系，checkpoint 已保存，无实验运行记录。
- 最终回答使用 8 条引用，两篇各 4 条。逐项核对均不超过 10 个英文词，链接指向真实已保存记录，所在 chunk 有 agent 实际读取收据。
- 早期 3 条超长引文被检查点明确说明以短引文替换，未用于最终展示；旧记录保留审计。因此最终产物引用协议通过，不能声称所有历史引文从未违反格式。
- Codex 核对已保存正文：正确区分 encoder 全位置注意力、decoder 因果自注意力、cross-attention 和 BERT 双向 encoder；训练目标和输入表征比较、BLEU/GLUE 不可横比、GLUE 排除 WNLI 的统计口径均有正文依据。Transformer 表 2 英法 41.8 与正文 §6.1 的 `41 . 0` 确实同时存在于保存的正文中，回答保留差异而未捏造解释。
- 一处技术表述需收紧：MLM 的“避免目标直接看到自身”是简化，选中位置的 80% MASK / 10% 随机词 / 10% 原词规则已正确保存在结构化训练主张，但最终解释应保留这一限定。人工科学审阅仍标为 pending，不冒充人工批准。
- 首次完成后关闭 Harness，重新建立生产 bridge / SDK client，resume 同一 session，仅要求根据现有 checkpoint 简短回顾。恢复成功，同一项目，读取仍为 7、引用仍为 12、实验仍为 0，没有重复工作；预算上限、研究计时起点不变，请求继续累计，最终无 pending reservation。

用量：首次任务为 26 次研究内请求、870307 个已报告 token；真实重启续接增加 1 次请求、81776 token，最终累计 27 次 / 952083 token。建项前的首次模型请求不在该研究账本中；这些数值不是精确账单或费用承诺。原 1000000 token 阈值保留，未扩容。后续不要在该记录上自动追加耗时研究或反复重跑。

本次证明 Sol 可以完成这条真实论文比较链路并真实重启续接，不能外推为所有真实科研任务、实验、长代码审批或桌面证据跳转都已验收。下一步优先复核阅读范围与上下文重复带来的高 token 用量，再进行独立的小型实验用例和完整桌面呈现验收。后续服务恢复时也可继续 Luna 原用例，但不能把这次 Sol 结果记作 Luna 通过。
