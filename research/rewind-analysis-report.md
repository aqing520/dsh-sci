# Rewind 本地逆向调研记录

> 本记录基于本机 Rewind 安装目录和解包样本的静态分析，仅提炼可复现的架构事实；没有把 Rewind 私有源码、插件或资源复制到 dsh-sci。

## 分析对象

- Rewind Electron 外壳：`research/rewind-inspect`
- Rewind 安装时的 Harness 扩展：`C:\Users\wzy\AppData\Local\Programs\Rewind\resources\harness-update-base\plugin`
- 分析工具：本地 `morluto/rea` 6.8.0
- 精确入口分析结果：`research/rewind-analysis.json`

REA 对 15 个外壳入口文件的结果：5 个 BrowserWindow、92 个 IPC 操作、38 个主进程 handler、11 个 contextBridge API、3 个 renderer 入口；主 bundle 没有解析失败。完整依赖目录有 13,354 个文件，已避免把第三方依赖作为主结论。

## 架构

```text
Electron main process
  ├─ 启动校验、更新、崩溃恢复、托盘和窗口
  ├─ 生成/维护 DSH profile patch
  ├─ 启动 dsh-desktop-host 子进程
  └─ 通过 dsh-app://app 加载隔离的 DSH Web UI
        └─ Rewind Harness plugin
             ├─ Rewind API 身份和短期 model grant
             ├─ Rewind LLM adapter
             ├─ Rewind web search provider
             ├─ 后台 workspace/session capture
             ├─ quota provider
             └─ 原生升级/备份支持
```

外壳的 BrowserWindow 使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` 和自定义 `dsh-app:` 协议。主界面通过 preload 暴露窄 API，IPC handler 检查 sender/frame；Platform 账户页使用独立 session partition，并只允许目标 origin 导航。

## Rewind 做的事情

1. **远端模型代理**：profile 将默认 provider 改为 `rewind`，禁用官方 DeepSeek provider。插件从 DSH credential store 读取 Key，换取短期授权，再转发 OpenAI Responses 流式请求；授权会续期，Key 变化会使旧 grant 失效。
2. **后台捕获**：监听 DSH session/agent 事件和 workspace 变化，把会话事件、文件观察、附件、快照和运行记录异步写入本地 stateRoot。捕获是后台观察，源码明确标注不能证明精确的工具文件归属或科学有效性。
3. **远端备份/发布**：捕获结果按项目生成 manifest 和对象，支持 trace、git、附件、Harbor 记录等对象的分块上传，并在服务端确认 manifest 后记录已发布状态。失败会重试，运行中的任务会让发布让步。
4. **Web search**：注册独立 `rewind` 搜索 provider，通过模型授权调用服务端搜索并返回引用来源。
5. **额度**：提供 `rewindQuotaProvider`，回合结束后刷新额度；GUI 插入额度 UI。
6. **产品策略**：保留设置和模型选择的必要部分，默认关闭 schedule、agent preset、plan、goal、trajectory 等 UI；关闭默认 workspace，更新入口指向 `https://apiwharf.com/downloads`。
7. **更新和恢复**：基础安装有 manifest/hash 校验；feature update 使用签名 envelope、白名单路径和原子替换；启动时验证版本，另有 mandatory update、startup error、crash report 和“禁用第三方插件后重启”的恢复路径。

## 与当前 dsh-sci 的差异

当前 dsh-sci 已经采用 Electron → 独立 DSH Web/Harness 子进程 → loopback URL 的主架构，也已接入 TokenFans provider。与 Rewind 相比，尚缺少：

- DSH 插件形式的会话/工作区后台捕获；当前 `src/capture.ts` 只保存简单 JSONL 和文件列表快照。
- 稳定的本地 capture store、会话归属、增量文件观察和附件索引。
- 后端无关的 provider adapter 生命周期（短期 grant、凭据失效、流式代理错误分类）。
- 额度 provider、引用型 Web search 和 workspace/session history UI。
- 签名更新、版本清单、启动完整性检查和崩溃恢复。
- Rewind 那种有意裁剪/重排 DSH UI 的产品策略。

## 建议迁移顺序

### 第一阶段：本地记录能力

在 dsh-sci 自己的命名空间实现 `capture` 插件：监听 session events，追加原子 JSONL，按 workspace 维护文件 hash/revision，生成 session index、workspace snapshot 和附件索引。先不上传、不绑定任何第三方服务。

### 第二阶段：可替换的服务接口

抽象 `ModelGateway`、`SearchProvider`、`QuotaProvider` 和 `BackupPublisher`，默认实现使用 TokenFans/自有后端；凭据继续走 DSH credential store，API key 不写 profile patch。服务端 API 只接受显式配置，避免把 Rewind 的 APIWharf 地址硬编码进 dsh-sci。

### 第三阶段：产品 UI

增加历史会话检索、workspace 快照、捕获状态、导出和额度卡片。通过 DSH plugin patch 插入，避免 fork 官方 DSH Web UI。

### 第四阶段：发布可靠性

再加入 manifest/hash、签名更新、原子发布和恢复报告。Rewind 的更新协议可以作为设计参考，但不应复制其私有协议或密钥。

## 结论边界

- 能确认的是 Electron/DSH/plugin 的静态边界、配置、事件监听、文件 schema 名称和网络调用形状。
- 不能仅凭静态分析确认服务端实现、真实上传内容、运行时可达性、服务器权限或完整 UI 路由。
- `app.asar` 与 `harness-update-base/plugin` 是两个不同层次；只分析 app.asar 会漏掉 Rewind 的核心 capture/backup/plugin 逻辑。
