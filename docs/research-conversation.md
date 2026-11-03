# 主对话科研实现与验证

日期：2026-11-03。实现方案见[在主 Agent 中实现科研能力](research-native-agent-direction.md)。

## 已接通的链路

主 Harness 加载 `desktop/dsh-sci-research-plugin.mjs` 的 conversation 分支，向当前 Agent 注册命名科研工具。原有 external-runner 分支保留其工具限制、任务协议与独立 SDK 兼容路径。

主对话不再读取全局 active-context.json：插件从实际执行者的 session 取 ID 和 cwd，宿主使用 realpath 归一化目录，按 session+workspace 的哈希持久化绑定。模型生成的 request 不能覆盖该身份。主 bridge 使用 `ResearchConversations` 限制项目和动作，并为当前目录创建受控的 Orchestrator 视图，复用现有仓储、版本、引用、代码和实验实现。

研究只在需要时创建。内部使用一个连续的 conversation 执行身份保存读取收据和预算，不生成强制七阶段计划。普通问答没有研究项目。任务完成状态与科学结论验收不混为一谈。

当前能力：

| 能力 | 实现 |
| --- | --- |
| 文献与证据 | research_search/read/cite/claim/evidence；实际正文 chunk、当前任务读取收据和精确引文匹配；未读正文不能通过 cite |
| 假设与设计 | 保存可观察预测、反驳条件、对照和指标；修订保留原版本 |
| 代码 | 新建不可变 bundle、hash 校验读取、完整读取后记录静态审查；静态审查不等于执行 |
| 实验 | 对话内设计批准与具体提案执行批准；展示命令、目录、代码、输入、输出与版本；宿主重新核对 hash 后执行 |
| 结果 | 实际 run、退出状态和输出 manifest；research_analyze 保存指标/不确定性；反驳结果不改写原预测 |
| 恢复 | 项目级 checkpoint 和引用、加密仓储支持；同目录其他会话可显式恢复；已完成提案直接返回已有 run |
| 上下文 | 自动注入当前问题、checkpoint、近期来源/主张/运行、预算摘要和相关研究记忆；证据与记忆均标为待核对上下文 |
| 控制 | 直接的人类 slash commands 管理预算、暂停、恢复、新问题及旧项目迁移，不需要额外模型调用 |

## 模型和预算

工具沿用原 Agent 的 adapter、provider、model 和凭据解析。native hook 返回 DSH 当前 request config，不创建 ModelGateway、不读取另一份凭据、不经过独立 Responses 代理。

在 agent/request 边界预留请求，按 session 的 assistant/message 或 assistant/attempt 结算；缺失 usage 记 unknown，中断不退款。agent/turn-stopping 等待最终结算落盘，避免 UI 显示回合结束时漏掉最后一笔用量。同回合八次请求没有新的科研操作会停止；新的用户回合可继续，原预算不重置。

边界：自动开启研究的第一次模型调用发生在 research_begin 创建项目之前，属于普通聊天路由调用，不追溯伪装成“已提前预留”的科研请求。先执行 /research-new 可以在下一次模型调用前建立预算。计量点是 DSH Agent request；不据此声称已独立观测每个 adapter 内部的网络重试。Token 阈值依赖已返回 usage，不是精确费用封顶。

用尽额度后，/research-budget 仍可通过可信的人类命令入口调整上限，保留已用量；restart 才重新起算墙钟。模型工具请求扩大预算或替换已有研究时必须取得 DSH approval 的 allowed-once。

## 审批与恢复边界

主 bridge 为可信宿主审批另发 capability。普通 research_action 不能调用审批、执行、改预算或伪造 session；HTTP 层覆盖请求体中的 trustedApproval，只有专用 header 匹配才获得该权限。插件仅在人类 DSH 审批通过或执行显式 slash command 时使用此 capability。

native 实验要求保存的设计和代码 bundle、完整静态审查且无 blocker；批准后再次核对文件 hash。拒绝、取消或没有审批服务时不执行。失败/中断的提案需审阅并新建提案；完成的提案不会重复运行。

旧计划可由 /research-adopt 显式迁移。迁移使用既有计划提交 journal，保留来源、引用、结果、预算和 superseded 计划；新 conversation plan 不继承旧实验的执行审批，旧代码需要按新计划重新准备和绑定。活跃模型请求和未完成实验会阻止迁移。

捕获现在写入每 workspace 索引，切目录/重启后的 diff 使用该目录的历史快照。lifecycle 按 session.cwd 查对应快照，找不到时不再借用默认目录的文件 hash。主对话 bridge 在目录活动时限频采集，并在 checkpoint 和实验结束时采集；原默认目录的后台 monitor 保留。尚不是所有打开目录的持续文件 watcher。

## 验证与剩余工作

- `test/research-conversation.test.ts`：明文/加密文档比较、真实读取收据、伪造引用拒绝、项目/目录隔离、checkpoint 恢复、当前模型配置保留、usage/unknown 结算、预算停止和显式扩容、实际本地实验与拒绝审批、反证保留原预测、旧项目迁移、无进展停止。
- `test/capture.test.ts`、`test/lifecycle-plugin.test.ts`：交替目录和重启后的 diff，以及 session→workspace 快照归属。
- `npm run research:conversation:smoke`：真实 DSH Agent、生产插件、命名工具及本地合成 SSE provider；同一对话完成两份文档阅读和引用，以自然语言结束，再重启 Harness 恢复同一研究。没有真实模型 API、付费额度或科学质量断言。
- 原 external SDK、guard、IPC、迁移及恢复回归继续保留；release preflight 加入 native conversation smoke，package smoke 检查 conversation 内核文件。

本轮记录：全量回归 433 项（431 通过、2 跳过、0 失败）；随后更新目录视图与辅助审阅入口的 48 项相关测试通过。真实 DSH smoke 完成 9 次合成模型调用，其中开启研究后的 8 次计入项目预算、合计 64 个已报告 token，保存 2 次正文读取和 2 条匹配引用，重启后无重复读取。production main 的 Electron 权限 smoke 拒绝全部 35 个只读写入通道，并验证来源预览、窗口身份及正常退出。native/PTC 外部 runner guard 和包含 59 个运行文件的 package smoke 均通过。原始本地记录保存在 Git 忽略的 research/rewind-analysis-local/。

后续增量：已在官方 keyed toolview slot 实现可展开的正文、引句、主张、证据关系、运行及产物卡片，附本地 fragment 定位；增加真实 React 渲染和引用跳转测试。compaction 的辅助 llm/stream 调用计入当前研究预算，保留原 provider/model，不重复计量普通 Agent 请求。Luna 真实调用暴露的首次 newResearch 误审批和可选版本号空字符串问题已修复并有回归。

换设备同步前合并了 origin/main 的项目删除、文档/目录导入、刷新和启动更新。合并后 build 通过，完整回归 438 项（436 通过、2 跳过、0 失败）；native conversation smoke 与 59 文件的 package smoke 重新通过。build 清理 dist，必须先完成 build 再执行依赖 dist 的测试。

用户已选择 TokenFans Luna 做真实验收。/codex 出现服务过载/无可路由节点；/v1/responses 的 gpt-6-luna 短请求和部分 Agent 工具调用曾成功，但完整任务因后续服务过载未完成。不能把此次网络可用性与局部调用说成科研质量通过。

仍需完成：完整真实模型科研任务与科学内容人工验收；完整桌面中的证据卡片、缺失/折叠目标定位及审批呈现；真实长上下文、辅助调用计量和恢复；真实实验及反证处理。切换设备后的具体执行逻辑见[开发交接](development-handoff-2026-11-03.md)。没有通过这些检查前，不把整体改造标为全部完成。


## Mac 接续完善（2026-11-03）

生产 context 注入已替换原始 JSON 字符串切片，超限时按完整记录缩减并显式标记省略，保留预算、checkpoint 与未解决冲突 ID。项目删除增加持久删除标记、项目写入串行化、待结算请求/运行实验/待恢复 journal 保护，并清理所有相关会话绑定，拒绝晚到写入复活已删项目。

最新 Mac 全量回归为 451 项通过、0 失败、0 跳过；conversation、package 与生产 Electron 权限 smoke 通过。真实 Luna 首次及同会话恢复均遇服务过载，尚未创建研究，不能视为科学或真实恢复验收通过。详细操作、证据范围和下一步见[最新接续记录](development-handoff-2026-11-03.md#配置凭据后的接续完善)。
