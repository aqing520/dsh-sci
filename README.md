# dsh-sci

Current version: **0.1.0**. Release notes are tracked in [CHANGELOG.md](CHANGELOG.md).

`dsh-sci` is a clean-room reconstruction of the useful local architecture observed in Rewind: a workspace-scoped agent runtime, permission modes, local tools, model-provider adapter, and durable session/workspace capture.

It does not contain APIWharf server code or copied proprietary source. The provider layer accepts an OpenAI Responses compatible endpoint, so a compatible API can be supplied through environment variables.

## Run

```powershell
npm install
npm run build
node dist/src/index.js --workspace D:\path\to\project --permission read-only "Summarize the project files"
```

Environment variables and local provider selection:

- `DSH_SCI_PROVIDER` (`tokenfans-codex`, `openai`, or `custom`; default: `tokenfans-codex`)
- `DSH_SCI_BASE_URL` (TokenFans default: `https://tokenfans.ai/codex`)
- `DSH_SCI_API_KEY` or provider-specific `DSH_SCI_TOKENFANS_API_KEY`
- `DSH_SCI_MODEL` (TokenFans default: `gpt-6.1-sol`)

For local development, put these values in an ignored `.env.local` file. The packaged desktop build also reads `dsh-sci.config.json` beside the executable, so it can start with a default provider without environment variables:

```text
DSH_SCI_PROVIDER=tokenfans-codex
DSH_SCI_BASE_URL=https://tokenfans.ai/codex
DSH_SCI_MODEL=gpt-6.1-sol
DSH_SCI_TOKENFANS_API_KEY=your-key-here
```

Without an API key, the agent reports that model access is unavailable. Local inspection is still available through `--list-files`, `--read-file`, and `--snapshot`.

## Permission modes

- `read-only`: list and read workspace files.
- `workspace-write`: also create or replace files under the workspace root.
- `full-access`: also permits command execution. Treat this mode as trusted local code execution.

## Local inspection

```powershell
node dist/src/index.js --workspace D:\path\to\project --list-files --depth 3
node dist/src/index.js --workspace D:\path\to\project --read-file README.md
node dist/src/index.js --workspace D:\path\to\project --snapshot
```

## Desktop app and Windows package

```powershell
npm run desktop       # compile and open the Electron desktop app
npm run dist:win     # produce a portable Windows executable under release/
```

The desktop window exposes provider, model, endpoint, API key, workspace, permission, and prompt fields. It sends the key only to the local main process for the current request; packaged files do not include `.env.local`.

When a default key is placed in `dsh-sci.config.json`, it is necessarily recoverable by anyone who receives that file or the packaged executable. Remove the file and enter the key in the settings panel when the key must remain private.

The project is a clean-room functional reconstruction. It contains newly written orchestration and local tooling based on observed behavior; it does not reproduce Rewind's proprietary source, embedded assets, or APIWharf's server-side implementation.

The core runtime is deliberately separate from any future Electron UI. This keeps the permission boundary and capture behavior testable.
