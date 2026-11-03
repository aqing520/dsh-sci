# 换设备开发交接与后续执行逻辑

日期：2026-11-03。仓库：<https://github.com/aqing520/dsh-sci>。

这是一份开发进度交接，当前改造尚未全部验收完成。先读本文，再读[产品方向](research-native-agent-direction.md)和[实现与验证](research-conversation.md)。Rewind 的参考依据见[逆向分析报告](../research/rewind-analysis-report.md)。

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

当前脚本遇到错误会保存 status 并退出，**尚无原地 resume 参数**。后续应先补保存部分 snapshot、同 session 恢复及明确的重试逻辑，再用它观察中断恢复；不要把新建输出目录的全新运行算成“恢复成功”。首次模型选择研究前的调用不在研究项目预算中，如需覆盖全部验收费用，可由可信宿主预先绑定研究，或实际使用 `/research-new`，不能伪造追溯预留。

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
