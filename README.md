# dsh-sci

Current version: **0.2.2**. Release notes are tracked in [CHANGELOG.md](CHANGELOG.md).

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
```

When a default key is placed in `dsh-sci.config.json`, it is necessarily recoverable by anyone who receives that file or the packaged executable. Remove the file and enter the key in the settings panel when the key must remain private.

The project is a clean-room functional reconstruction. It contains newly written orchestration and local tooling based on observed behavior; it does not reproduce Rewind's proprietary source, embedded assets, or APIWharf's server-side implementation.

当前版本已加入本地优先的工作区捕获层：官方 DSH 桌面启动时会在用户数据目录下维护 `capture/snapshots`、`capture/workspace-index.json`、`capture/capture-status.json` 和 `capture/research-records.json`。快照记录文件大小、SHA-256 和新增/删除/变更列表；科研记录使用 `dsh-sci.research-record.v1` 格式，保存运行 ID、项目 ID、快照关联和捕获状态。记录会跨重启恢复比较基线，写入使用临时文件加原子替换。该层只做本地元数据记录，不会自动上传工作区内容，也不会宣称已完成精确实验输入或工具归因。

DSH 生命周期也会通过独立的 `dsh-sci-lifecycle` 插件记录到 `capture/sessions/dsh-session-events.jsonl`。它捕获会话创建、会话事件、Agent 状态、刷新和销毁边界，限制事件大小并过滤密钥、令牌、Cookie、密码等敏感字段。该日志只写入本机，不会上传；它是运行过程观察记录，不能替代经过验证的实验输入或完整工具归因。

The intended architecture is Electron host → isolated DSH Harness process → authenticated loopback Web UI → DSH plugins and profiles. This follows the public architecture used by the official Harness and community desktop hosts while keeping dsh-sci's own code in a separate integration layer.
