# dsh-sci

Current version: **0.2.2**. Release notes are tracked in [CHANGELOG.md](CHANGELOG.md).

科研 Agent 的交付采用 **DSH 插件 + 本地研究内核 + Research Workspace**。详细工作包、验收标准和剩余事项见 [实施计划](docs/research-agent-implementation-plan.md)，真实案例协议见 [基准案例](docs/research-agent-benchmark.md)。P0 已得到失败基线，P1 的结构完成门槛及任务/时间/模型请求预算已落地；完整科研闭环尚未验收。

Research Workspace 的“查看和设置预算”可设置任务执行次数和从首次执行起的总时间（包括暂停/退出）。重试计次，重启/重新规划不重置；耗尽暂停，先取消仍在运行的 Agent，再明确修改预算和单独恢复。旧项目需显式设置预算；旧计划需重新规划。模型无权扩充预算。产品内核已统一计量规划、重新规划与 SDK 模型请求，网络尝试前持久化预留，usage 缺失记为 unknown。工作区可设置请求额度和已报告 token 停止阈值；token 不保证精确费用封顶。v1 预算需明确设置模型额度后升级，历史用量标记未计量。详见 [模型预算与边界](docs/research-model-budget.md)。真实科研复验另行验收。

新任务结果采用 v2 协议，必须携带计划、执行身份、提交 ID 和预期状态版本；不为旧结果自动补身份。同一提交重复到达会返回原结果，修改内容则拒绝。接受后写入中断由提交日志恢复，不再次调用模型或实验；旧执行器返回也不会误改新计划。协议与边界见 [结果提交与恢复](docs/research-result-protocol.md)。完整真实科研复验仍待进行。

`dsh-sci` is a local-first desktop host built on the official open-source DeepSeek Harness runtime. The desktop process starts a bundled DSH Web profile and loads its authenticated loopback UI. Project-specific behavior belongs in DSH-compatible plugins and patches.

It does not contain APIWharf server code or copied proprietary source. The provider layer accepts an OpenAI Responses compatible endpoint, so a compatible API can be supplied through environment variables.

## Run

```powershell
npm install
npm run desktop:dev
```

The desktop development command starts the official DSH runtime through the local `@deepseek-ai/dsh` package. It stores the Harness home under Electron's per-user data directory and disables telemetry by default for this local build:

```powershell
npm run desktop
```

When launched from an installed shortcut, the initial DSH workspace is the current user's Documents directory. The DSH directory picker can then switch to a project folder.

启动时 dsh-sci 会自动注册一个 `TokenFans Codex` 自定义提供方，使用 OpenAI Responses 兼容协议和 `https://tokenfans.ai/codex`。它会读取 `DSH_SCI_TOKENFANS_API_KEY`，也可以在 exe 旁边的 `dsh-sci.config.json` 中配置；进入 DSH 的设置 → Models 后即可看到并选择该模型。TokenFans 密钥不会写入 profile 配置文件。

开发过程中不需要反复安装 exe：在项目目录运行 `npm run desktop:dev`（或 `npm run desktop`）即可直接启动 Electron 开发版本。修改主进程或 TypeScript 后重新运行该命令；只有准备交付给别人时才运行 `npm run dist:win` 生成安装包。

A packaged build uses the bundled DSH runtime and does not require a separate `dsh` command or Node.js installation on the target computer.

Environment variables and local provider selection:

- `DSH_SCI_PROVIDER` (`tokenfans-codex`, `openai`, or `custom`; default: `tokenfans-codex`)
- `DSH_SCI_BASE_URL` (TokenFans default: `https://tokenfans.ai/codex`)
- `DSH_SCI_API_KEY` or provider-specific `DSH_SCI_TOKENFANS_API_KEY`
- `DSH_SCI_MODEL` (TokenFans default: `gpt-6.1-sol`)

For local development, put these values in an ignored `.env.local` file. The packaged desktop build also reads `dsh-sci.config.json` beside the executable, so it can start with a default provider without environment variables:

```json
{
  "DSH_SCI_PROVIDER": "tokenfans-codex",
  "DSH_SCI_BASE_URL": "https://tokenfans.ai/codex",
  "DSH_SCI_MODEL": "gpt-6.1-sol",
  "DSH_SCI_TOKENFANS_API_KEY": "your-key-here"
}
```

Without an API key, the agent reports that model access is unavailable. Local inspection is still available through `--list-files`, `--read-file`, and `--snapshot`.

## Permission modes

- `read-only`: list and read workspace files.
- `workspace-write`: also create or replace files under the workspace root.
- `full-access`: also permits command execution. Treat this mode as trusted local code execution.

## Desktop app and Windows package

```powershell
npm run desktop       # compile and open the Electron desktop app
npm run dist:win     # produce a Windows NSIS installer under release/
npm run package:smoke # verify build outputs and electron-builder inclusion rules without packaging
npm run release:audit # report whether existing release installers match package.json
npm run release:preflight # run build, tests, research smoke checks, recovery audit, and release checks
npm run research:provider:smoke -- 20 # opt-in live provider check; consumes model tokens
npm run research:app-crash:smoke # Electron main-process crash/restart recovery smoke
npm run recovery:audit # inspect local capture state and report pending/failed backup jobs
npm run recovery:restore -- <audit-bundle.json> <empty-capture-root> # restore metadata into an empty directory
```

`recovery:audit` is read-only and prints JSON. It checks `DSH_SCI_CAPTURE_ROOT`, an explicitly supplied path, or `%APPDATA%\\dsh-sci\\capture` by default on Windows. A malformed index returns a non-zero exit code.

`recovery:restore` accepts a JSON file produced by **Export audit bundle** and writes only metadata into a new or empty capture directory. It validates the bundle schema and refuses to overwrite a non-empty directory. Source files are never copied. The same operation is available in Capture History through **Restore metadata bundle**, where the app provides file and directory pickers.

When a default key is placed in `dsh-sci.config.json`, it is necessarily recoverable by anyone who receives that file or the packaged executable. Keep the file outside shared/package inputs and use environment variables or an OS-managed launch environment when the key must remain private; the current Capture History settings panel does not edit provider credentials.

The project is a clean-room functional reconstruction. It contains newly written orchestration and local tooling based on observed behavior; it does not reproduce Rewind's proprietary source, embedded assets, or APIWharf's server-side implementation.

本地捕获现在还会维护：

- `capture-settings.json`：捕获开关和快照/研究记录保留上限。
- `capture/snapshots/index.json`：按项目累计的快照历史和 revision 序号。
- `capture/sessions/<sessionId>/events.jsonl` 与 `session.json`：每个 DSH 会话的独立事件和状态索引。
- `capture/sessions/index.json`：所有会话的可查询索引。
- 事件中的显式文件/目录字段会记录为 `observedPaths`，并将 session 标记为 `toolAttribution: partial`；这仍是观察结果，不代表精确工具归因。
- `capture/research-records.json`：可按项目、会话、时间查询并导出 JSON/JSONL 的研究记录索引。
- `capture/artifacts/index.json`：将生命周期事件观察到的路径关联到 workspace 快照中的文件大小和 SHA-256；外部路径只保留元数据，不读取或上传文件内容。
- `capture/research-runs/index.json`：按 DSH session 关联可观察到的运行生命周期、事件数、观察路径和 artifact ID；运行输入和结果仍明确标记为 `unverified`。

Workspace snapshot 默认跳过 `.env`、`.env.*`、`dsh-sci.config.json`、credentials/secrets/private-key 文件、PEM/KEY/P12/PFX/CRT 文件，以及项目的 `release` 目录和 Electron `.asar`/blockmap 产物，不会为这些文件计算 hash。

如果本机需要保护捕获 metadata，可在启动 dsh-sci 的环境中设置 `DSH_SCI_METADATA_PASSPHRASE`。捕获 JSON、脱敏事件 JSONL、backup queue 和本地 manifest 会使用 scrypt 派生密钥与 AES-256-GCM 加密；passphrase 只从启动环境或 `CaptureStore` 构造参数读取，永远不会写入 runtime settings、捕获目录或安装包。未设置时继续使用现有明文格式，旧明文也能直接读取。加密目录缺少 passphrase 时应用仍会启动，Capture History 会显示 `locked`，原数据保持不变；恢复审计 bundle 时可通过同一环境变量或 `restoreAuditBundle(..., { metadataPassphrase })` 写入加密目录。

捕获层提供 `CaptureStore.setEnabled`、`CaptureStore.updateSettings`、`queryResearchRecords`、`searchHistory`、`listSessionEvents`、`listArtifacts`、`exportResearchRecords`、`exportAuditBundle` 和 `cleanup` 接口；`exportAuditBundle` 会同时导出 session 索引、脱敏 session 事件和 artifact 索引。Capture History 面板可以修改捕获开关、快照/记录保留上限和按天保留策略，也能查看 session timeline、观察路径、artifact 元数据、research record、snapshot 和 backup publication 的详情。Research runs 表格会直接显示 provider/model、观察到的调用数量、带错误的调用数量和最近观察时间；展开详情后还能查看调用首末时间、事件序号、关联事件类型和 session 脱敏事件顺序。面板还显示有效 provider/service 配置摘要，endpoint 会去掉 query，密钥只显示是否已配置，不会回显密钥；Runtime settings 可以保存 provider、model、非敏感 endpoint 和 service retries 到用户数据目录的独立 `runtime-settings.json`，保存后重启应用生效，环境变量仍优先；workspace snapshot 展开后可直接查看 added/changed/removed 路径列表。面板中的 **Refresh** 会重新读取当前本地状态，备份历史会显示实际 publisher 来源。桌面菜单中的 **Queue Metadata Backup** 会把当前快照和研究记录加入持久化队列；默认只记录元数据，不上传源码内容。面板也提供本地历史检索，会跨 research record、workspace snapshot、session 索引和脱敏 session event 返回命中摘要，支持多关键词 AND 匹配、按命中类型、session ID、project ID、ISO 时间范围和 offset/limit 分页筛选。

第二阶段增加了后端无关的 `ModelGateway`：它使用 OpenAI Responses 兼容协议，支持普通响应、SSE 流式响应、超时和鉴权/权限/限流/网络/服务端错误分类。桌面启动时 provider、model 和捕获记录使用同一份配置。主菜单中的 **Capture History** 可以查看本地研究记录和 workspace 快照。 已预留 `SearchProvider`、`QuotaProvider` 和 `BackupPublisher` 边界；默认搜索不可用、额度为 unknown，备份只写本地 metadata-only manifest，不会上传源码。

桌面还会维护 `startup-state.json`，用于识别上次未正常退出并在启动错误页给出恢复提示。
启动失败时还会在用户数据目录的 `startup-diagnostics/` 中保存脱敏的最新诊断和最多 20 个历史诊断文件；错误页提供重试启动、复制诊断和下载 JSON 操作，不会把令牌或 API key 写入诊断内容。

发布包可在 exe 同目录放置 `dsh-sci.integrity.json`，启动时会对 manifest 中列出的文件执行 SHA-256 和大小校验，并拒绝越过发布根目录的符号链接；v2 manifest 还记录算法、生成器版本和应用版本，版本或生成器不匹配时拒绝启动；没有该文件时不会改变开发启动流程。

可用 `npm run integrity:manifest -- <root> <output> <relative-file> ...` 生成 manifest，例如：`npm run integrity:manifest -- release/win-unpacked dsh-sci.integrity.json resources/app.asar`。

服务接口也提供了可选 HTTP 实现：`HttpSearchProvider` 请求 `/search`，`HttpQuotaProvider` 请求 `/quota`，`HttpBackupPublisher` 请求 `/backup/manifests`。Capture History 的 Service tools 区域可以在配置后执行搜索和额度查询；搜索结果会显示为带来源和摘要的引用链接，额度会显示剩余量、上限、重置时间和服务消息，原始返回仍可展开查看；未配置时显示 unavailable。它们只在显式配置并调用时启用，支持瞬态错误重试；备份发布会使用确定性的 manifest ID 和 `Idempotency-Key`，便于服务端幂等处理。桌面现在维护持久化的 backup queue：菜单发布动作先入队，启动恢复未完成任务，后台按退避策略重试可恢复错误；配置了 `DSH_SCI_SERVICE_BASE_URL` 和 `DSH_SCI_SERVICE_API_KEY` 时使用 HTTP publisher，否则使用本地 metadata-only publisher。

HTTP 服务配置使用 `DSH_SCI_SERVICE_BASE_URL`、`DSH_SCI_SERVICE_API_KEY`、`DSH_SCI_SERVICE_TIMEOUT_MS`、`DSH_SCI_SERVICE_RETRIES` 和 `DSH_SCI_SERVICE_PROVIDER`；配置加载会读取 workspace 的 `.env.local` 或外部 `dsh-sci.config.json`，service key 与模型 provider key 隔离，不会复用 `DSH_SCI_API_KEY`。

HTTP adapter 还通过本地集成测试验证真实 loopback HTTP 交互，包括 `/search`、`/quota`、`/backup/manifests`、Bearer 鉴权、瞬态错误重试、幂等键和空 204 成功响应。

Backup queue 中永久失败的任务可在 Capture History 里直接 Retry；该操作复用原任务的 metadata ID 集合并重置尝试次数，不会新建重复任务。

Retention cleanup 会同时重建 session index，保证已删除的旧 session 不会继续出现在历史列表或导出中。
清理时只处理 session 目录，不会把 `dsh-session-events.jsonl` 等聚合日志误当成目录。
CaptureStore 会串行化 snapshot 和 cleanup 的索引变更，避免定时捕获与手动清理互相覆盖。
捕获设置更新也使用同一串行化边界，避免修改保留上限时与定时快照交错。
捕获错误状态写入也纳入该边界，避免旧错误覆盖最新状态。
备份 publication 历史写入也使用同一边界，避免并发发布丢失历史记录。

Session event 文件使用安全的目录编码，即使收到异常的 dot-segment session ID，也不会写到 capture 根目录之外。

Responses 流式响应会处理没有换行结尾的最后一个 SSE `data:` 事件。
HTTP backup publisher 会接受空的 204 成功响应，服务请求在重试退避期间被取消时也不会再发起下一次请求。
手动 Retry 会等待正在运行的队列处理完成后再修改队列文件，避免并发覆盖状态。
菜单入队操作也会等待当前后台处理完成，避免定时任务和手动入队互相覆盖队列状态。
桌面正常退出时会最多等待 5 秒让当前 backup 发布完成；超时后仍会退出，并由下次启动恢复队列状态。

`DSH_SCI_PROVIDER=openai` 或 `custom` 时，桌面会把同一 provider、base URL 和 model 写入 DSH profile route；TokenFans 仍是默认值。
当前版本已加入本地优先的工作区捕获层：官方 DSH 桌面启动时会在用户数据目录下维护 `capture/snapshots`、`capture/workspace-index.json`、`capture/capture-status.json` 和 `capture/research-records.json`。快照记录文件大小、SHA-256 和新增/删除/变更列表；科研记录使用 `dsh-sci.research-record.v1` 格式，保存运行 ID、项目 ID、快照关联和捕获状态。记录会跨重启恢复比较基线，写入使用临时文件加原子替换。该层只做本地元数据记录，不会自动上传工作区内容，也不会宣称已完成精确实验输入或工具归因。

DSH 生命周期也会通过独立的 `dsh-sci-lifecycle` 插件记录到 `capture/sessions/dsh-session-events.jsonl`。它捕获会话创建、会话事件、Agent 状态、刷新和销毁边界，限制事件大小并过滤密钥、令牌、Cookie、密码等敏感字段。该日志只写入本机，不会上传；它是运行过程观察记录，不能替代经过验证的实验输入或完整工具归因。

生命周期插件还会写入 `capture/research-runs/`，把同一 session 的创建、事件、Agent 状态和销毁边界聚合为一个 `dsh-sci.research-run.v1` 运行记录。该记录只表示本地观察到的生命周期，不宣称已获得精确用户输入、完整模型调用或成功实验结果。
运行记录还会保存事件类型计数、保守的 input/output/tool/error/status 观察计数，以及不包含原文的 input/output 摘要计数；这些是基于公开事件名称的统计，不是私有协议解析。
如果事件数据显式包含 `requestId`、`responseId`、`messageId`、`callId`、`toolCallId`、`completionId` 或 `traceId`，运行记录会保存脱敏后的标识符、调用类别、出现次数和事件类型；没有显式标识符时不会推断调用关联。
调用关联还会保存首次/最近观察时间、事件序号和是否出现错误事件，用于重建可观察的顺序；这仍然不是完整的模型调用 trace。

The intended architecture is Electron host → isolated DSH Harness process → authenticated loopback Web UI → DSH plugins and profiles. Both desktop windows use context isolation, disabled Node integration, and Electron sandboxing; Capture History exposes only its narrow settings, refresh, search, and quota bridge. This follows the public architecture used by the official Harness and community desktop hosts while keeping dsh-sci's own code in a separate integration layer.

## Research Workspace（科研 Agent 核心）

完整的分阶段实施计划见 [docs/research-agent-implementation-plan.md](docs/research-agent-implementation-plan.md)。

当前版本已经加入可恢复的科研项目核心。桌面菜单中的 **Research Workspace** 可创建研究问题、激活默认计划、启动下一任务、暂停/恢复项目和导出 JSON。计划默认拆为澄清问题、资料检索、形成假设、设计实验、执行实验、评估结果和撰写报告七步；每个任务有依赖、状态、尝试次数、输入/输出引用和事件记录。

研究数据存放在用户数据目录的 `capture/research/`：项目和计划使用 JSON，项目事件使用 JSONL，并沿用 `DSH_SCI_METADATA_PASSPHRASE` 的 AES-256-GCM metadata 加密能力。Electron 主进程通过 `research:*` IPC 操作核心编排器，因此应用重启后可以从持久化计划和事件恢复。

DSH profile 现在独立安装 `dsh-sci-research` 插件。插件使用公开的 Cordis `ctx.on`、`ctx.provide` 和 `ctx.effect` 边界，将 DSH session 与研究项目/任务上下文关联，并记录 session 创建、事件和销毁边界；它不依赖 Rewind 私有 API，也不把生命周期观察误报为精确输入或完整 trace。

研究核心还支持来源、引用、主张和证据链接；可从 HTTP 搜索结果或本地 Markdown、HTML、JSON、纯文本文件登记来源，并保存内容哈希。实验定义要求显式审批后才执行命令，记录 stdout/stderr、退出码、超时、取消和输出截断。Research Workspace 可生成带来源编号的 Markdown 报告；报告保存来源内容、run、artifact 和 evaluation 的绑定哈希，可信 Workspace 审阅后，上游证据变化会使旧审阅自动过期。跨会话研究记忆使用本地向量加词法检索；每次检索保存可重建的索引版本和命中记录，并隔离 embedding provider/model/dimensions。设置 `DSH_SCI_MEMORY_EMBEDDINGS=1` 且 provider 可用时，记忆会改用兼容 `/embeddings` 的远程向量服务；没有配置时自动使用本地降级。新 DSH 研究会话会把当前项目的中高可信度记忆以只读方式注入任务上下文。设置 provider key 时，研究计划会优先让模型提出结构化任务图，解析失败或服务不可用时回退到本地七步计划。上述数据都写入 `capture/research/`，沿用 metadata 加密配置。

研究来源也可以通过 `research_action` 的 `reference` 动作解析 DOI、Crossref、arXiv 和开放网页；本地文档解析支持基础 PDF 文本、Markdown、HTML、JSON 和纯文本。扫描型 PDF 通过可注入的 `ResearchOcrProvider` 接口接入 OCR，也可以使用无 shell 的 `createCommandOcrProvider` 对接本地 OCR wrapper；没有 provider 或 OCR 失败时会明确标记 `ocr-required`。OCR provider 可以返回聚合置信度和页级置信度，文档 chunk、来源 metadata 和报告会保留这些值；低置信度页会进入证据警告，要求人工核对扫描页。实验运行会保存输入/输出文件 SHA-256、受限环境摘要、随机种子、代码版本和命令参数，并可通过策略限制输入累计字节、输出累计字节、workspace 总字节和可选的进程内存上限；内存读数不可用时 manifest 会明确标记为未强制执行。`evaluation`/`evaluate` 动作保存指标、预期值、不确定性、样本量和结论；`decide-iteration` 会在评估未通过或存在未审阅冲突时暂停决策，并在完成审阅后保留旧计划审计记录。跨会话记忆会合并重复内容、按可信度排序并过滤过期条目；Research Workspace 可以逐组或批量查看和审阅冲突记忆，批量结果会为每个冲突写独立审计事件，审阅结果会持久化为 `accepted`、`superseded`、`ignored` 或 `unresolved`，Agent 也可通过 `memory-conflicts` 查询冲突。

桌面启动时可通过 `DSH_SCI_OCR_COMMAND` 启用命令式 OCR wrapper；命令以 `shell:false` 启动，PDF 路径作为最后一个参数，stdout 可返回纯文本或 `{"text":"...","pageTexts":[...]}`，可用 `DSH_SCI_OCR_ARGS`（JSON 字符串数组）、`DSH_SCI_OCR_PROVIDER`、`DSH_SCI_OCR_TIMEOUT_MS` 和 `DSH_SCI_OCR_MAX_OUTPUT_BYTES` 配置。将 `DSH_SCI_OCR_PROVIDER` 设为 `tesseract` 或 `tesseract-ocr` 且不设置 wrapper 命令时，会先用 `pdftoppm`（可由 `DSH_SCI_PDF_RENDER_COMMAND` 覆盖）按页渲染，再用 Tesseract（可由 `DSH_SCI_TESSERACT_COMMAND` 覆盖）识别；语言、DPI 和页数分别可由 `DSH_SCI_TESSERACT_LANGUAGE`、`DSH_SCI_TESSERACT_DPI`、`DSH_SCI_TESSERACT_MAX_PAGES` 配置。两个外部进程均以 `shell:false` 启动，并受超时、取消和输出上限约束。也可以设置 `DSH_SCI_OCR_ENDPOINT` 接入 JSON 云 OCR provider，并使用独立的 `DSH_SCI_OCR_API_KEY`、`DSH_SCI_OCR_MAX_REQUEST_BYTES`；请求只发送明确配置的文档 base64，不复用模型或服务 API key。

Agent 现在可以通过 `research_action` 提交 `task-result`：一次携带任务状态、摘要、主张、引用、证据链接和产物引用，由本地状态机校验后推进任务或进入阻塞/审批状态。`ResearchRunner` 可在步数预算内自动执行非审批任务；SDK 子进程或传输中断时会重建 client 并使用已保存的 research session 继续当前任务。实验执行还会按 workspace 根目录、允许的命令和超时策略校验，并使用受限环境变量启动子进程。可通过 `DSH_SCI_EXPERIMENT_COMMANDS`（逗号分隔）覆盖默认命令白名单。

评估器优先在本地计算可复现统计量：`mean-difference`、`proportion-difference`、`confidence-interval`、`cohens-d`、`welch-t` 和 `mann-whitney-u` 会保存 `dsh-sci.stats.v1` 版本、原始输入、估计值、标准误、置信区间、p 值（适用时）和方向结论；小样本、t 检验假设和秩检验 ties 会生成 `reviewRequired` 与 `reviewReasons`，模型只负责解释限制和提出下一步，不负责改写统计结果。

Research Workspace 的“研究审批队列”可按项目和任务查看待批准任务与尚未运行的实验，预览命令、参数、工作目录、输入输出、随机种子和超时。批准任务和批准执行实验分别授权；需要审批的关联任务未获批时，实验不能执行。新实验绑定当前计划，重新规划后旧实验提案不能沿用新计划审批。暂停项目和同一内核中的重复并发实验启动也会被拒绝。

“生成报告”会保存新报告；“导出已有 HTML 证据图”和“导出已有 Markdown 报告”通过只读 IPC 读取最近一次已生成报告，不新增报告或项目事件。需要更新内容时先重新生成。研究 bridge 会对能归属到现有项目的已认证动作记录接受/拒绝事件，仅保存动作、执行方和结果，不保存请求正文或 provider 错误原文。

`research:provider:smoke` 使用应用实际配置（包括 `.env.local`）驱动官方 DSH SDK，以真实上游模型执行 2—50 个合成任务，默认 20 个；在两段运行前各断开一次 loopback 连接，中途重新打开 Repository 和 SDK 进程，检查原会话恢复及每项任务只完成一次。它不加入常规 preflight，运行会消耗模型 token；脱敏结果保存在 `research/validation/`，失败时保留临时诊断目录。这个检查证明受控断连和 SDK 重启后的继续执行。Windows 开发版完整 Electron 主进程崩溃恢复已通过单独的 `research:app-crash:smoke` 验证；系统网络故障、版本升级和安装版恢复仍待验收，详见 [科研 Agent 验收记录](docs/research-agent-validation.md)。
