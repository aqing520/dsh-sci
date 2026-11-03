# Rewind 本机逆向与 dsh-sci 底层能力对照

更新：2026-11-03（Asia/Singapore）。dsh-sci 基线：`98b7063`，版本 `0.2.2`。

下文差距针对改造前基线；后续实现进展见[主对话科研实现与验证](../docs/research-conversation.md)。

本轮问题：Rewind 如何把能力装进原有 DSH Agent；哪些做法能帮助 dsh-sci 在当前对话中完成科研，而不要求用户另开科研工作区。

## 结论

当前 dsh-sci 已有不少科研内核代码，主要问题是它们没有形成主 Agent 连续可用的能力。新增独立页面无法解决模型、凭据、session、workspace 和执行生命周期的割裂。

Rewind 值得借鉴的是同一 Harness 中的插件、服务和生命周期集成。它不是科研能力的验证样本，不能据此推断其具备文献评价、科学推理或实验有效性。

建议目标：用户留在原对话，Agent 按问题调用检索、正文阅读、证据、设计、实验和记忆工具；内核保存状态并校验事实。证据面板和审阅页面作为按需查看的辅助入口。见[主 Agent 科研能力方案](../docs/research-native-agent-direction.md)。

## 对象与边界

- 官方工具：[morluto/rea](https://github.com/morluto/rea)，使用官方 npm 包 `rea-agents@6.8.0` CLI。
- 工具目录：`C:/Users/wzy/.codex/tools/rea-research`；未改 Codex MCP 配置或产品依赖清单。
- 分析 Node：工具目录中的 `24.22.1`；默认 Node `24.15.0` 不满足本次 REA 的 engine 范围。
- Rewind 安装目录：`C:/Users/wzy/AppData/Local/Programs/Rewind`。
- 外壳：`resources/app.asar`，`rewind-harness@1.0.7`。
- 活跃插件：`resources/harness-update-base/plugin`，`@windong/rewind-harness-plugin@1.0.7`。
- 仅分析发布文件；未启动 Rewind、未读账户/凭据/聊天记录、未调用其服务、未执行样本代码。
- 不把 Rewind 私有源码或资源提交到产品。本报告的行为解释为重新表述。

原始证据保存在 Git 忽略目录：

| 本地文件 | 内容 |
| --- | --- |
| `research/rewind-analysis-local/2026-11-03/identity.json` | 版本、所选路径、逐文件 SHA-256 |
| `research/rewind-analysis-local/2026-11-03/plugin-summary.json` | REA 插件摘要、覆盖率和限制 |
| `research/rewind-analysis-local/2026-11-03/plugin-evidence.json` | 插件完整 Evidence bundle |
| `research/rewind-analysis-local/2026-11-03-shell/identity.json` | 外壳所选路径及 SHA-256 |
| `research/rewind-analysis-local/2026-11-03-shell/shell-summary.json` | REA 外壳超时结果，内含 details.partial_observation 完整部分证据；不是精简摘要 |
| `research/rewind-analysis-local/evidence-index.json` | 本轮从原始结果提取的紧凑索引与覆盖率 |

插件 parent Evidence：`ev_b549a86ec70b09f6e19301852d13f19bd931acae4f9d375c14f1899f7413ef3c`。目录身份 SHA-256：`19561893c01331f7723478dc4f4ac47b7f28bf6e1c3946e2cbdebd91c3f81451`。

插件选取 `package.json`、`lib/index.js`、`lib/native-worker.cjs`、`lib/first-upgrade.cjs`。REA 报告 3 个 JS 文件完成语法解析、0 个解析失败，另有 14 个库存文件未选中。语义图触及每文件 20,000 节点上限，属于 partial，不能宣称完整恢复所有调用链；下表还逐段核对了 bundle 中对应函数。

外壳选取自有 JSON、JS/CJS、HTML，排除第三方依赖。第一次含 CSS 的调用被参数校验拒绝，随后按命令支持的文件集合纠正并单独重跑外壳，没有重复分析成功的插件。

外壳在 lib/welcome/welcome.js 触及 REA 每源文件 300,000ms deadline，返回 provider_timeout，已保留部分 Evidence，未再次计算相同文件。部分 Evidence ID：`ev_b29e3d8b602c8b3cd73fce9ddfc5c06dd8af1e037d641b43e9700eaa2c5b8b75`；ASAR SHA-256：`fca9535421869391b262730b6583737edd3c116d929f5a7a9ed2386eed37d589`。已解析 7 个 JS、跳过 4 个，语法失败 0；不能把它当成整个外壳已分析完成。lib/main.js 和已完成的 preload 观察仍被保留；外壳行为结论另外核对了发布文本。

所有观察都是静态证据：注册语句不等于运行时可达。本轮未验证服务端实现、实际上传内容、交互外观、真实性能或恢复成功率。

## Rewind 如何集成能力

下表 `S` 指 ASAR 的 `lib/main.js`，`P` 指活跃插件的 `lib/index.js`；行号仅适用于本轮 identity 中的文件。

| 问题 | 静态观察及位置 | 可借鉴之处 |
| --- | --- | --- |
| 接入 Agent | P:8174 注入 llm/credentials/sessions/agents；P:8337–8435 安装对话策略、搜索、capture、quota 和模型 adapter。 | 能力作为当前 Harness 的插件服务和工具，不要求另开一个可见 Agent。 |
| 配置一致性 | P:2357–2453 解析凭据并管理授权；P:8406–8416 注册 adapter，凭据引用更新时使相关缓存失效。S:13352–13423 生成不含 key 的 profile。 | 复用当前模型与凭据引用，在调用边界解析。短期 grant 是其自有后端需求，并非我们必须实现的功能。 |
| 原对话搜索 | S:13377 附近设置 web.searchProvider；P:8349–8355 向已有 web 服务注册搜索 provider。 | 把搜索接到原 Agent 工具链，而不只提供一个页面 API。 |
| 工作归属 | P:7978–8170 有 workspace 发现和 workspace/opened 处理；P:8418–8428 订阅 session/agent，并在 turn/end 刷新 quota。 | 上下文、捕获和实验目录按 session/workspace 绑定，状态随对话更新。 |
| 长任务 | P:7368–7483 在请求前计量上下文，限定压缩和恢复次数，并检查压缩是否有效。 | 运行时预算、进展判断与恢复同样属于能力；不只是加一段 system prompt。不要照搬其模型参数。 |
| 后台资源 | P:8203–8217 有 checkpoint、分批发现、CPU work/pause、frame、watcher 和重扫参数。 | 后台记录要控制资源；配置存在不能证明真实不卡顿。应先测量再决定是否增加 watcher。 |
| 产品外壳 | S:13248–13335 用插件 ID 调整显示策略；S:17297–17335 用协议和 sender 检查衔接外壳和 Harness。 | 学插件边界；不能因为它隐藏计划 UI 就移除科研需要的计划和进度。 |

## dsh-sci 的实际断点

### P1：默认聊天与自动科研不是同一条执行链

`desktop/main.mjs:369` 明确拒绝官方 DeepSeek 自动科研，`:546` 不为它创建模型规划器。科研 SDK profile 使用 openai-responses（`src/research/dsh-sdk.ts:180`），预算代理转发 /responses（`src/research/model-budget-proxy.ts:68`）。

默认安装能聊天不代表独立页面里的自动科研可用。这是确定的源码分支。不能只删 guard；应让当前会话通过 DSH adapter 使用科研工具，并在统一请求边界接入预算。

### P1：聊天设置与科研配置脱节

聊天 profile 的 apiKeyEnv 通过 DSH credential store/环境解析（`desktop/provider-profile.mjs:18,38`）；科研 provider/key 在主进程启动时从环境和配置加载并缓存（`desktop/main.mjs:533–546`）。SDK 使用独立 home（`:378`），缺 key 直接失败（`src/research/dsh-sdk.ts:386`）。

因此在模型设置填 key、切模型，不会同步这套启动时配置。应共享 DSH 的 provider/凭据引用和能力状态，不要求重复配置或复制明文凭据文件。

### P1：工作区归属没有完整跟随会话

`desktop/main.mjs:519` 固定默认 workspace；实验策略（`:592`）、15 秒快照（`:617`）和科研 cwd（`:380`）使用它。lifecycle 虽记录 session.header.cwd（`desktop/dsh-sci-lifecycle-plugin.mjs:235`），事件归属仍从全局 workspace-index.json 获取（`:118–122,240–244`）。

推断：切到另一个聊天目录后，聊天、捕获和科研执行目录可能不一致；本轮未做切换复现。应先建立 session→workspace→research project 绑定。

### P1：工具已进主对话，上下文和完成协议仍围绕外部 runner

并非“完全没接入”：`desktop/dsh-sci-research-plugin.mjs:86–108` 已注册 research_context/research_record_event/research_action，`:117–138` 有 system prompt hook。

断点：普通对话的 context tool 只读内存绑定；绑定又 fallback 到全局 active-context.json（`:79,91,113,147–148`）。自动研究记忆注入只在 external runner 分支执行（`:123–126`）。完成提示强调 task result schema 和 Workspace 审批（`:133–135`），外部 SDK 再要求 JSON 收据（`src/research/dsh-sdk.ts:246–249`）。

注册一个万能 JSON action 工具还不足以让当前聊天自然科研。需要可靠的 session 绑定、按需上下文、工具契约和内核收据；用户读自然语言解释。

### P2：页面按钮承担了工作流

`desktop/research-dashboard.mjs:370–372` 统一输出整套按钮，`:365` 主要展示执行结果 JSON。`desktop/main.mjs:134–156` 分别打开捕获和科研窗口。用户被要求操作内部状态机。

用户已明确底层能力是目标；优先级应改成原会话内完成科研。已有审阅功能保留为辅助入口，不需要先删内核或重画全部界面。

## 纠正旧记录

生命周期捕获、文件 hash/快照差异、artifact 索引、本地历史检索、备份队列、启动诊断、完整性校验、正文/引用/证据、设计/代码绑定、实验、评估、记忆和恢复均已有实现。

旧报告中的“只有简单 JSONL”“缺少 capture 插件”已过时。签名自动更新和部署可靠性仍有差距，但不应排在科研主链路之前。普通网页搜索、Crossref 书目发现、正文获取是不同能力，不能混称。

## 完成范围

- 已回答：安装身份、外壳/插件边界、Harness 集成模式、当前源码断点及主对话迁移方向。
- 部分回答：长任务和后台资源策略，只有静态实现证据。
- 未覆盖：服务端、Rewind 科学能力、真实交互体验、端到端科研质量、实际 workspace 切换复现。
- 交付复现脚本：`scripts/research-rewind-inspect.mjs`；原始输出留在 Git 忽略目录。
- 本轮只改调研资料和复现脚本，未改产品运行逻辑；方案不代表已经实现。
