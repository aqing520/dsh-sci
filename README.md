# dsh-sci

`dsh-sci` 是在官方开源 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/dsh) 之上构建的本地科研 Agent 桌面工作区。

它保留 DSH 的对话、工作区、工具和插件运行时，同时增加可恢复、可审阅、可追溯的科研工作流：研究问题拆解、资料阅读、来源与引用、假设、实验设计、代码暂存、受控实验、结果评估、迭代、报告和跨会话研究记忆。

项目定位是 **DSH 桌面宿主 + DSH 插件 + 本地研究内核**，不修改 DSH 核心，也不包含其他产品的私有代码。

> 当前版本：`0.2.2`。科研内核和桌面工作区已经具备结构化能力与自动化回归；真实科研案例仍需人工审阅来源、设计、实验结果和报告，合成 smoke 测试不等于科学结论验收。

## 在 DSH 基础上增加了什么

### 桌面宿主和插件

- 使用 Electron 启动官方 DSH Harness，并自动选择可用的本地 loopback 端口。
- 通过 DSH profile patch 注入 `dsh-sci-lifecycle` 和 `dsh-sci-research` 插件。
- 窗口使用 context isolation、sandbox 和受限 IPC；科研操作通过项目级 bridge 进入本地内核。
- 支持启动诊断、Harness 重启、SDK 子进程重建和中断恢复。
- 可生成独立 Windows NSIS 安装包，目标电脑不需要另装 Node.js 或 `dsh` 命令。

### 本地捕获和历史

- 记录 DSH session 生命周期、脱敏事件、workspace 快照、观察路径和 artifact 元数据。
- Capture History 查看研究运行、会话时间线、快照差异、调用观察统计、恢复状态和备份队列。
- 支持本地历史检索、metadata-only 审计包导出和恢复。
- 默认跳过 `.env`、密钥文件、证书、`dsh-sci.config.json`、`release/` 和 Electron 产物。

### 科研 Agent 内核

研究项目默认分为七类任务：澄清问题、检索阅读、形成假设、设计实验、执行实验、评估结果、生成报告并决定迭代。

内核已经提供：

- 版本化研究计划、任务依赖、重试、暂停和崩溃恢复。
- DOI、Crossref、arXiv、开放网页以及 Markdown、HTML、JSON、纯文本和基础 PDF 读取。
- 来源内容版本、文档 chunk、引用、主张、证据关系和来源关系。
- 可注入 OCR provider；扫描 PDF 没有 OCR 时明确标记 `ocr-required`。
- 结构化假设与实验设计；设计修订会使旧审批失效。
- 内容寻址的代码 bundle、静态语法检查、完整文件读取和代码 review。
- 显式审批后才执行受限命令，记录输入/输出 hash、环境、随机种子、命令、超时、取消和退出状态。
- 可复现的差异、比例、置信区间、效应量、Welch t、Mann–Whitney U 和配对 bootstrap 评估。
- Markdown/JSON/HTML 报告、来源编号、证据图、限制和新鲜度检查。
- 词法 + 本地向量检索的跨会话研究记忆，可选 OpenAI-compatible embedding endpoint。
- 任务、墙钟、模型请求、已报告 token、未知 usage 和迭代预算账本；预算耗尽后暂停，模型不能自行扩充。
- 结果提交协议、幂等收据、恢复 journal、计划版本绑定和项目级安全审计。

### 模型和服务 provider

模型层使用 OpenAI Responses 兼容协议，支持普通响应、SSE 流式响应、超时、取消、重试和错误分类。内置：

- `tokenfans-codex`：默认 TokenFans Codex 路由。
- `openai`：OpenAI 官方接口。
- `custom`：任意兼容 `/responses` 的代理或本地服务。

搜索、额度和 metadata backup 使用独立的 HTTP provider 边界，服务密钥与模型密钥分开。

## 快速开始

### 使用 Windows 安装包

安装 `dsh-sci Setup 0.2.2.exe`，启动后选择 DSH 工作区目录。默认工作区是当前用户的 Documents，也可以在 DSH 内切换项目目录。安装包不包含开发者的 `.env.local` 或 API key。

### 从源码运行

要求 Windows、Node.js 20+ 和 npm：

```powershell
git clone https://github.com/aqing520/dsh-sci.git
cd dsh-sci
npm install
npm run desktop:dev
```

`desktop:dev` 会先编译 TypeScript，再启动 Electron 和 DSH runtime。修改主进程或 TypeScript 后重新运行即可。

### 配置模型

开发环境在项目根目录创建被 Git 忽略的 `.env.local`：

```env
DSH_SCI_PROVIDER=tokenfans-codex
DSH_SCI_BASE_URL=https://tokenfans.ai/codex
DSH_SCI_MODEL=gpt-6.1-sol
DSH_SCI_TOKENFANS_API_KEY=your-key
```

OpenAI 示例：

```env
DSH_SCI_PROVIDER=openai
DSH_SCI_BASE_URL=https://api.openai.com/v1
DSH_SCI_MODEL=gpt-4.1
DSH_SCI_API_KEY=your-key
```

其他兼容接口：

```env
DSH_SCI_PROVIDER=custom
DSH_SCI_BASE_URL=https://your-gateway.example/v1
DSH_SCI_MODEL=your-model
DSH_SCI_API_KEY=your-key
```

**Capture History → Runtime settings** 可以修改 provider、model、endpoint 和重试次数，但只保存非敏感设置，不保存 API key；保存后重启应用生效。

打包版也支持在 exe 同目录放置 `dsh-sci.config.json`，但该文件对本机用户可见，不适合存放多人共用的私钥。正式产品应让客户端连接由你控制的后端，由后端保存 provider key。

### 开始研究

1. 打开 **Research Workspace**，创建研究项目并填写问题、范围、预算和预期产物。
2. 查看计划、任务依赖和完成标准。
3. 让 Agent 检索来源、阅读正文并保存引用。
4. 审阅假设和实验设计；设计、代码和执行审批分开处理。
5. 审批具体实验提案后执行，检查指标、样本量、不确定性和证据冲突。
6. 选择迭代、暂停或生成报告；后续会话可检索该项目的研究记忆。

实验命令始终经过 workspace、命令、输入、输出和资源限制。模型可以提出实验，但不能伪造人工审批或自行扩充预算。

## 数据、恢复和隐私

运行数据默认位于：

```text
%APPDATA%dsh-sci
```

主要内容包括 `harness/`、`capture/`、`capture/research/`、`research-sdk/`、`runtime-settings.json` 和 `startup-diagnostics/`。研究项目、来源、实验、评估、报告和记忆索引都保存在 `capture/research/`。

设置 `DSH_SCI_METADATA_PASSPHRASE` 后，捕获和研究 metadata 使用 scrypt + AES-256-GCM 加密。密码短语只从启动环境读取，不写入配置、profile 或安装包。

`.env.local`、`dsh-sci.config.json` 和 `config/` 已加入 `.gitignore` 和安装包排除规则。不要把 API key 提交到 Git、截图、日志或共享安装目录；已经暴露过的 key 应立即撤销并重新生成。

## 二次开发

### 代码结构

```text
desktop/
  main.mjs                         Electron 主进程、菜单、IPC、Harness 启动
  provider-profile.mjs             DSH provider/plugin patch
  dsh-sci-lifecycle-plugin.mjs     生命周期捕获插件
  dsh-sci-research-plugin.mjs      科研工具插件
  research-dashboard.mjs           Research Workspace UI
  capture-dashboard.mjs            Capture History UI
src/
  provider.ts                      Responses/embedding ModelGateway
  capture.ts                       快照、session、artifact 和历史
  research/                        研究模型、仓储、编排器和执行器
  runtime-settings.ts              桌面非敏感设置
test/                               Node test + tsx 回归测试
scripts/                            smoke、live provider 和发布脚本
docs/                               协议、边界、验收和迁移文档
```

### 扩展 DSH 插件

插件以 ESM 模块放在 `desktop/`，通过 DSH profile patch 注入。生命周期插件使用公开 Cordis 边界（`ctx.on`、`ctx.provide`、`ctx.effect`），科研插件通过认证 bridge 调用 `ResearchOrchestrator`。

新增插件时：

1. 添加独立入口，避免直接修改 `node_modules/@deepseek-ai/dsh`。
2. 在 profile patch 中增加幂等的插件段。
3. 为输入、输出、权限、项目归属和错误建立 schema。
4. 通过 preload 暴露最小 IPC API，保持 context isolation、禁用 Node integration 和 sandbox。
5. 为重复调用、重启、旧计划、跨项目访问和密钥边界增加测试。

### 扩展研究能力

研究逻辑位于 `src/research/`，UI 只负责展示和调用。可扩展：

- `SourceAdapter`：将搜索或文献结果规范化为稳定 source。
- `ResearchOcrProvider`：返回文本、页码和置信度。
- evaluator：保存算法版本、原始输入、估计值、不确定性和 `reviewRequired` 原因。
- `BackupPublisher`、`SearchProvider`、`QuotaProvider`：复用错误分类、重试和取消语义。
- planner provider：只返回结构化计划；失败必须保留原因，不能把本地 fallback 冒充模型计划。
- memory embedder：隔离 endpoint、key、model、version 和 dimensions，避免混用旧索引。

研究写入应通过 `ResearchOrchestrator` 和 `ResearchRepository`，不要在 UI 或 Agent bridge 中直接改 JSON。新增字段时同步更新 schema、迁移、恢复语义和审计记录。

### Provider 接口

`src/provider.ts` 的 `ModelGateway` 要求：

- `POST {baseUrl}/responses`
- 普通响应或 SSE `data: {...}` 与 `[DONE]`
- `Authorization: Bearer <key>`
- 请求体包含 `model` 和 `input`

兼容服务可直接使用 `DSH_SCI_PROVIDER=custom`；专有协议应在 gateway 边界适配，不要散落在研究任务代码中。

## 常用命令

```powershell
npm install
npm run desktop:dev
npm run build
npm test
npm run package:smoke
npm run research:harness:smoke
npm run research:sdk:smoke
npm run research:workspace:smoke
npm run research:access:smoke

# 明确选择后才运行，会消耗模型 token
npm run research:provider:smoke -- 20

# Windows 安装包
npm run dist:win

# 发布和恢复检查
npm run release:audit
npm run release:preflight
npm run recovery:audit
npm run recovery:restore -- <audit-bundle.json> <empty-capture-root>
```

`npm test` 是本地行为回归，不等于真实科研结论验证。带 `live` 或 `provider` 的脚本可能访问外部服务并消耗模型额度。

## 构建和发布

```powershell
npm run dist:win
```

输出位于 `release/`：`dsh-sci Setup <version>.exe` 是 NSIS 安装包，`win-unpacked/` 可用于本机启动检查，`.blockmap` 和 `latest.yml` 是更新元数据。安装包排除了 `.env.local`、`dsh-sci.config.json`、`config/`、`research/` 和开发测试文件。

当前未配置 Windows 代码签名证书，安装包可能显示“未知发布者”；正式发布时应增加代码签名和可信发布渠道。

## 当前边界

- 这是科研工作流基础设施，不会自动保证论文结论正确。
- 开放网页、摘要和 OCR 内容需要来源和正文审阅才能作为强证据。
- token usage 缺失时记录为 unknown；模型预算不是精确费用封顶。
- 自动计划、实验执行、报告和记忆检索都保留人工审阅边界。
- 当前重点验证 Windows 开发版和本地恢复；升级兼容、系统级网络故障、Linux 实机和生产规模服务仍需独立验收。

详细协议和边界：

- [科研 Agent 实施计划](docs/research-agent-implementation-plan.md)
- [科研 Agent 验收记录](docs/research-agent-validation.md)
- [研究模型预算与边界](docs/research-model-budget.md)
- [结果提交与恢复协议](docs/research-result-protocol.md)
- [来源、正文和引用](docs/research-source-content.md)
- [假设与实验设计](docs/research-hypothesis-design.md)
- [研究记忆](docs/research-memory.md)
- [研究安全边界](docs/research-security.md)
- [变更记录](CHANGELOG.md)

## License

See [LICENSE](LICENSE). `dsh-sci` contains newly written integration and research orchestration code and uses the official DSH package as a dependency.
