# Changelog

## 0.2.2 - 2026-10-27

- Added a built-in TokenFans Codex provider for the official DSH Web profile.
- TokenFans is selected as the default model route and no longer requires DeepSeek API login.
- Disabled DeepSeek-only search routes when the TokenFans profile is active.

## 0.2.1 - 2026-10-26

- Pinned Electron to 44.7.0, which is supported by the official DSH native runtime.
- Added a direct `desktop:dev` command so development does not require installing an exe.
- Included sanitized Harness diagnostics when startup fails.
- Added a preconfigured TokenFans Codex route through DSH's OpenAI Responses compatible provider.

## 0.2.0 - 2026-10-26

- Switched the desktop architecture to the official open-source DeepSeek Harness runtime.
- Added a bundled Harness launcher that waits for the authenticated loopback Web URL.
- Added explicit Harness startup diagnostics and per-user Harness state.
- Packaged launches now use the user's Documents directory as the initial workspace and keep Harness output drained during long sessions.
- Pinned Electron to the official DSH-compatible 44.7.0 runtime and added a direct developer launch command.
- Startup failures now include sanitized Harness diagnostics instead of only reporting the exit code.
- Changed Windows packaging from portable-only output to an NSIS installer target.
- Kept the previous AgentRuntime behind an explicit `DSH_SCI_RUNTIME=legacy` development switch.

## 0.1.0 - 2026-10-26

- Added the clean-room local workspace agent runtime.
- Added permission modes, workspace tools, session capture, and snapshots.
- Added OpenAI Responses compatible provider selection.
- Added TokenFans Codex configuration and Electron desktop packaging.
- Added the Windows portable build workflow.

## Versioning

Every user-visible release must update the `version` field in `package.json` and add a matching entry here before packaging. `electron-builder` uses that package version for the Windows artifact name.
