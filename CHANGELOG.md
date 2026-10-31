# Changelog

## 0.2.2

- Added a persisted research-case resume/checkpoint command. It inspects the exact Workspace approval state and can resume the normal DSH runner after approvals, while refusing to approve designs, tasks, proposals, or experiments itself.
- Added immutable persisted iteration decisions and report bindings for stop, iterate, and review outcomes, including evaluation, budget, conflict, and plan-version context.

## Unreleased

- Make Windows experiment memory sampling tolerate slow CIM queries by serializing samples, using a bounded five-second query timeout, and recording enforcement only after a successful sample. Tighten offline case recovery so failed terminal projects are inspectable while frozen iteration limits still reject an invalid third plan.

- Allow the DSH research runner to bind its persisted SDK session identity to a plan version, so re-planning cannot resume a stale session from the superseded plan. The default project-scoped identity remains backward compatible.
- Persist plan-scoped research sessions under `agent-sessions/<planId>.json`, while retaining the legacy project session pointer. Replanned cases can restart with the matching SDK home without overwriting historical session state.
- Make case resume use plan-scoped SDK sessions by default; resumption still requires a valid budget window and normal approval gates.
- Use plan-scoped SDK sessions in the production Electron runner and SDK smoke.
- Refuse case resume before provider startup when the persisted wall-clock, request or token budget is expired/exhausted.

- Add bounded, lossless field paging for saved research hypotheses and experiment designs, including project-scoped read-only bridge access and revision guidance. Verify plain/encrypted reconstruction without creating reading receipts, revisions, or approvals.

- Add one bounded SDK result correction for unregistered output references, sharing the authoritative project reference registry. Feedback contains invalid positions and bounded registered IDs; the model resubmits its own result. Identity/reference correction shares a persisted per-attempt allowance that survives SDK reconnects, keeps the original budget, and never replaces completion or approval gates.

- Reject explicit HTTP 200 browser-challenge pages before creating source content; record restricted/access-challenge acquisitions, preserve earlier readable versions on refresh, and retain readable CAPTCHA research articles. Real PMC rejection and source-body regressions are recorded; historical cases are unchanged.

- Fail closed when automatic research lacks DSH guard/restriction/presentation APIs. Add real Harness native and default-PTC guard probes, including scoped tools, nested registry entry, monotonic policy denial, bridge approval refusal and Agent cleanup; include both in release preflight.
- Record fixed, sanitized case-proxy failure stages and transport codes to distinguish local connection failures from upstream HTTP statuses; reject redirects. Request compact model plans without echoing the full frozen protocol, while retaining the original protocol in persisted plans and SDK input.

- Added a read-only Research Workspace with main-process window/document identity checks, centralized IPC capability policies, and bounded source previews without reading receipts. Production Electron access checks cover all 35 write channels, forged roles, unbound/replaced documents, popup denial, unchanged project state and normal shutdown.
- Added offline copy-first research-store migration with immutable backups, source hash verification, derived project-index rebuilding, interrupted-run and reserved-budget recovery, format compatibility guards, legacy review/configuration gates, and repeat/resume safety. Plaintext/encrypted synthetic legacy fixtures and actual child-process exits are covered; installed upgrades and real scientific acceptance remain pending.

- Bound new evaluations and evaluation task completion to their current plan; iteration decisions now retain evaluation/context hashes. Replanning rejects task-only concurrent edits, preserves iteration bounds, and recovers accepted plan/project/decision/event writes through plaintext or encrypted journals without another model call. Shared in-process project queues coalesce concurrent decisions across kernel instances, and failed first planning can be explicitly retried without consuming an iteration. Added 66 behavior/recovery tests; real scientific-case acceptance remains pending.
- Added exact frozen-protocol propagation and replay conformance checks for the imputation case. Historical Bernoulli-mask/median-denominator candidate code remains unapproved evidence and cannot be resumed as a compliant run; independent replay now rejects protocol drift, incomplete matrices, duplicate IDs and non-review eight-repeat controls.
- Added replay provenance binding to an approved design, immutable staged code, successful terminal run, launch manifest, and registered artifact hashes; replay no longer trusts output-directory names.

- Added immutable research report content bindings and trusted Workspace report reviews. A review is tied to the exact report hash and is marked stale when sources, runs, artifacts, evaluations, or memory inputs change.
- Added W11 report quality gates for exact source-content versions, approved experiment/design/evaluation/artifact provenance, broken evidence chains, statistical review requirements, immutable/corruption-checked snapshots, stale upstream detection, visible draft warnings, clickable evidence anchors, trusted Workspace review, and read-only exports. Synthetic validation is complete; the real scientific case remains pending.
- Added W12 immutable memory index snapshots with provider/model/version/dimension isolation, full rebuild and cancellation safety, Chinese character fragments and query rewrite audit, source-version bindings, conflict/expiry/applicability warnings, bounded cross-session task context injection, and retrieval provenance. The local baseline passes its query set; the configured live embedding endpoint returned HTTP 405 and remains pending.
- Added Workspace controls to rebuild a selected project's memory index and display applicability, exact source bindings, and retrieval warnings. Added pending-rebuild cancellation and independent embedding configuration/error boundary checks; local/live recall checks now share one frozen benchmark. Real embedding and scientific acceptance remain pending.
- Added host-issued read-only/project-scoped bridge capabilities and a bounded credential-free security audit with trusted Workspace viewing. Read-only requests reject record-writing operations and forged roles; audits whitelist fields, retain one outcome per request, encrypt and rotate records, and limit same-root flood writes. Migration, read-only Workspace sessions, independent security review, upgrade and full platform acceptance remain pending.
- Added rebuildable semantic-memory index versions and retrieval records with provider/model/dimension isolation. Memory searches now persist the index used and returned memory IDs.
- Fixed the whole-application crash smoke to follow the exact Workspace experiment preview and approval path; the recovery run now cleans the descendant process tree and prevents reruns after restart.
- Hardened timed-out DSH research turns: cancellation now force-closes the owned SDK process tree, revokes and drains the research bridge, waits for model proxy requests to settle, and reconnects with a fresh SDK/bridge boundary before retrying. Added regression coverage for late-turn isolation.
- Added deterministic paired percentile bootstrap evaluation with fixed seeds, input hashes, practical effect thresholds, small-sample review gates, and an independent numeric cross-check helper; eight-repeat controls remain inconclusive.
- Added trusted design-quality reviews with seven explicit criteria, exact design-hash/plan/hypothesis binding, stale-review invalidation, content freshness checks, encrypted persistence, and Workspace-only review controls; Agent bridge cannot write review conclusions.
- Added v2 task-result identities bound to plan, execution attempt and task state version; unbound legacy results cannot be submitted to current tasks.
- Added prepared/committed result journals with immutable submission hashes, replayable record/event IDs, encrypted persistence, and startup recovery without repeating model or experiment work.
- Added stale-executor guards so a late response or exception cannot mutate a replanned task with the same ID, plus write-boundary and real-process-exit recovery coverage.
- Added a frozen scientific benchmark and opt-in real-provider baseline runner with request/time limits, sanitized evidence, citation diagnostics, and explicit plan replay provenance; the end-to-end scientific case has not passed.
- Added shared task-result guidance, task-kind completion contracts, persisted output-ID validation, action restrictions, and explicit legacy-plan review gates.
- Added durable project task-execution and elapsed-time budgets, retry accounting, exhaustion pause, and trusted Workspace configuration that preserves counters and requires separate resume. Model request/token budgets remain outside the product kernel.
- Extended Electron Workspace smoke to budget editing and persisted counters; package smoke now checks research contracts, budgets, and process supervision output.
- Added a project/task-filtered Research Workspace approval queue with experiment command previews and separate task/experiment approval; old-plan proposals and concurrent duplicate starts are rejected.
- Added read-only saved-report IPC and Markdown/HTML downloads that do not regenerate reports or write project events.
- Added project-attributed bridge action accept/reject audit events without request bodies, and serialized event writes to preserve concurrent audit records.
- Extended Electron Workspace smoke coverage to task approval, experiment execution, escaped proposal titles, and read-only report retrieval.
- Added an opt-in live-provider SDK acceptance command with controlled loopback disconnections, persisted-session restart, and sanitized validation reports.
- Added durable experiment launch journals, owned-process cleanup, startup interruption recovery, and Electron whole-app crash/restart smoke coverage.
- Added real DSH Harness research-plugin smoke coverage, including authenticated Web startup and verification that `research_context`, `research_record_event`, and `research_action` register through `@deepseek-ai/dsh-tools`.
- Added structured `task-result` submissions and a bounded `ResearchRunner` for autonomous non-experiment task progression.
- Added workspace-root, command-allowlist, timeout, and restricted-environment checks for approved experiments.
- Added experiment input/output/workspace byte quotas and resource usage summaries in experiment manifests.
- Added conflict-memory grouping through the research bridge and a Research Workspace review view.
- Added persisted memory-conflict review states that filter superseded and ignored memories from retrieval.
- Added an injectable OCR provider boundary for scanned PDFs with explicit `ocr-required` failure state.
- Added automatic source quality scores and OCR-aware evidence warnings in reports.
- Made executor exceptions persist as task failures so the runner can retry them within task attempt limits.
- Added optional process-memory monitoring and peak memory metadata for approved experiments.
- Added memory-review status and unresolved-conflict sections to Markdown and HTML reports.
- Added deterministic `in-range` evaluation metrics and a review gate that blocks final iteration decisions while memory conflicts remain unresolved.
- Added `createCommandOcrProvider`, a shell-disabled OCR wrapper adapter with timeout, cancellation, output limits, and JSON page support.
- Added official DSH SDK child-process crash coverage so unexpected Harness exits surface as retryable task failures.
- Added SDK client reconstruction after transport/child-process failures, persisted-session resume, and 20-step mid-run crash recovery coverage.
- Added a shell-disabled Tesseract OCR provider that renders PDF pages with `pdftoppm`, OCRs them page by page, and enforces cancellation, timeout, page, and output limits.
- Added an opt-in JSON base64 HTTP OCR provider with an independent API key, request-size cap, timeout, cancellation, and response validation.
- Added deterministic statistical evaluators for mean differences, proportion differences, confidence intervals, and Cohen's d with versioned reproducible inputs.
- Added Windows CIM and Linux `ps` process-tree memory accounting, peak-memory manifests, and memory-quota termination coverage for experiments.
- Added transactional batch memory-conflict review through the local orchestrator and research bridge, with per-group audit events.
- Added Research Workspace batch conflict selection, select-all controls, and Electron smoke coverage for batch review persistence.
- Added OCR aggregate, page-level, and document-chunk confidence metadata with low-confidence evidence warnings in reports.
- Added Welch t-test and Mann–Whitney U evaluators with reproducible inputs and explicit manual statistical-review reasons.
- Extended recovery audit to detect duplicate IDs, broken cross-file references, and malformed observed-call ledgers, with corruption fixtures in the recovery test suite.
- Extended the official SDK smoke to drop the first local Responses connection and verify that the bounded runner recovers on the next provider attempt.
- Added cross-platform process-tree memory aggregation tests using Windows/CIM- and Linux/ps-shaped rows; WSL2 runtime verification remains a release-environment check when system resources permit.
- Added `release:preflight` to run the release-candidate build, tests, research smoke checks, recovery audit, syntax checks, and release audit in one machine-readable report.

## Unreleased

- Added the first recoverable Research Workspace core: persisted research projects, seven-step dependency plans, task state transitions, retry limits, pause/resume, event logs, encrypted metadata compatibility, and restart recovery.
- Added `dsh-sci-research` as an independent public-boundary DSH plugin with session/task context service and research session boundary events.
- Added Research Workspace IPC and dashboard actions for create, activate, start, pause, resume, export, and task progression; package smoke now verifies the research runtime files.
- Added persisted research sources, citations, claims, evidence links, document parsing, approved experiment runs, evidence-based Markdown reports, and searchable cross-session research memory.
- Research task context is now injected into public DSH system-prompt assembly for the active session, with a plugin service for task-boundary events.
- Added optional model-backed plan generation with local seven-step fallback, iteration/replanning after evaluation, an OpenAI-compatible embeddings boundary, and two DSH research tools for reading context and recording bounded task events.
- Added a read-only `recovery:audit` command that checks capture indexes, backup queue state, and startup diagnostics without contacting a service or modifying local data.
- Added optional AES-256-GCM metadata encryption using an explicitly supplied `DSH_SCI_METADATA_PASSPHRASE`, with plaintext compatibility, locked-state startup handling, encrypted lifecycle JSONL/queue/local manifests, and encrypted recovery restore support.
- Added metadata-only `recovery:restore` support for validating and restoring an audit bundle into an empty capture directory.
- Added Capture History pickers for restoring an audit bundle into a separate empty directory without touching the active capture root.
- Workspace snapshots now skip common credential and private-key file names before hashing metadata.
- Added a session-linked research-run ledger with explicit `unverified` input/outcome status and observed event/artifact counts.
- Added conservative event classification counters for research runs without persisting raw sensitive event content.
- Added input/output observation summaries with event and observed-path counts while keeping exact input and output status unverified.
- Added conservative model/tool call correlation for explicit request, response, message, call, completion, and trace IDs.
- Added first/last observation timestamps, event sequence numbers, and error-observed flags for correlated calls.
- Capture History research-run rows now show provider/model, observed-call and call-error counts, and the last observation time.
- Research-run details now expand into observed-call rows and a session event-order table sourced from sanitized lifecycle records.
- Workspace capture now skips generated `release` output and Electron `.asar`/blockmap archives, preventing package artifacts from breaking desktop startup capture.
- Capture History now shows a read-only effective provider/service configuration summary with redacted endpoints and credential-presence indicators.
- Workspace snapshot details now expand into added, changed, and removed path lists before the raw snapshot JSON.
- Added editable non-sensitive runtime settings for provider/service endpoints and model/retry values; settings are stored separately, exclude API keys, and apply after restart.
- Added a real localhost HTTP integration test covering search, quota, backup retry, authentication headers, idempotency keys, and empty 204 responses.
- Metadata restore now validates the structure of correlated-call entries while remaining compatible with older runs that did not record them.
- Added sanitized startup diagnostic files with an Electron recovery page that can copy diagnostics or relaunch the app.
- Extended integrity manifests with algorithm, generator, and app-version metadata; startup now rejects incompatible manifests.
- Added a direct startup-diagnostic download action and capped retained startup diagnostic history at 20 files.
- Added metadata-only artifact indexing for observed paths, linking workspace files to snapshots and sessions without reading or uploading source content.
- Added a Capture History session timeline and artifact table backed by the audit bundle.
- Added readable search citations and quota status cards to Capture History while retaining raw service details.
- Hardened Harness startup on Windows by attaching output listeners before the process can emit its URL and selecting an OS-assigned loopback port to avoid stale-process collisions.
- Added a local DSH lifecycle plugin that records sanitized session events and agent status transitions in JSONL for research-run traceability.
- Added persistent research records linked to workspace snapshots, with explicit uncertainty fields for unverified inputs and unavailable tool attribution.
- Added local structured history search across research records, workspace snapshots, sessions, and sanitized session events.
- Added local history search filters for hit type, session/project association, and ISO time bounds.
- Made local history search support multi-keyword AND matching and added project/time controls to Capture History.
- Added package smoke assertions and electron-builder exclusions for local secrets, config, research artifacts, and the removed preload.
- Rebuilt the session index after retention cleanup so deleted sessions cannot remain visible in Capture History.
- Hardened session directory encoding against dot-segment IDs and added lifecycle/capture path-boundary regression coverage.
- Corrected credential documentation and expanded package exclusions to cover an external root provider config file.
- Hardened retention cleanup to ignore aggregate session files while removing expired session directories.
- Fixed Responses SSE parsing when the final `data:` event is not newline-terminated.
- Made HTTP backup accept empty 204 responses and made retry backoff cancellation-aware.
- Made manual backup retry wait for an active queue processor to finish, preventing queue-file write races.
- Added a bounded backup-queue idle wait during graceful desktop shutdown.
- Isolated HTTP service credentials from the model provider API key.
- Included sanitized per-session event streams in audit-bundle exports.
- Expanded package smoke coverage to require all dynamically imported desktop runtime modules.
- Serialized backup enqueue operations behind active processing to prevent queue-file overwrite races.
- Serialized concurrent CaptureStore snapshot and retention mutations to protect index consistency.
- Made HTTP service adapters load workspace `.env.local` and external config values consistently with provider configuration.
- Serialized CaptureStore settings mutations with snapshot and retention writes.
- Serialized CaptureStore error status writes with other state mutations.
- Serialized backup publication history writes with snapshots, cleanup, and other CaptureStore mutations.
- Added a read-only release audit that reports whether existing installers match the current package version.
- Added a Capture History retry action for permanently failed metadata backup jobs.
- Removed the prototype AgentRuntime, its CLI, UI, tools, permissions and IPC endpoints. The desktop now runs only the official DSH runtime.
- Pointed start/dev commands at the desktop app, moved compiler/test tooling to development dependencies, and clean generated output before building.
- Removed unused prototype session logging APIs; retained workspace metadata capture and TokenFans credential loading.
- Added a backend-neutral OpenAI Responses `ModelGateway` with streaming support and classified provider errors, plus a local Capture History dashboard.
- Added explicit SearchProvider, QuotaProvider, and BackupPublisher boundaries with a local metadata-only manifest publisher.
- Added startup state tracking and recovery messaging for interrupted desktop launches.
- Added optional startup integrity verification from an external SHA-256 manifest.
- Added opt-in HTTP search, quota, and backup publishers with retry and provider error classification.
- Made the DSH profile route follow the selected TokenFans, OpenAI, or custom provider configuration.
- Added session history and complete local audit-bundle export to Capture History.
- Made provider profile patch generation idempotent and escaped user-configured YAML values; added a regression test for repeated startup updates.
- Added backup publication history to Capture History so failed and retried metadata-only publishes remain inspectable.
- Added a desktop action for queueing metadata-only backups and refreshing Capture History.
- Added Capture History settings for enabling capture, retention limits, time-based cleanup, and expandable metadata details.
- Added a durable backup queue with startup recovery, exponential retry for retryable publisher errors, and queue status in Capture History.
- Added opt-in Search and Quota controls to Capture History through the generic HTTP service providers.
- Added a package smoke check for required runtime files and electron-builder inclusion rules without generating an installer.
- Added an in-place Capture History refresh action so new capture and queue state can be viewed without reopening the panel.
- Added stable backup publisher attribution to publication history and audit exports.
- Made the backup menu action reuse active queue work instead of creating duplicate jobs; failed jobs can still be retried with a new enqueue.
- Added sanitized session event details to Capture History with tolerant JSONL recovery after interrupted writes.
- Hardened integrity manifests against root-escaping symlinks and added a Windows-aware regression check.
- Enabled Electron sandboxing for both the DSH window and Capture History window.
- Switched the sandboxed Capture History preload to a minimal CommonJS bridge for Electron runtime compatibility.

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

## 0.1.0 - 2026-10-26

- Added the clean-room local workspace agent runtime.
- Added permission modes, workspace tools, session capture, and snapshots.
- Added OpenAI Responses compatible provider selection.
- Added TokenFans Codex configuration and Electron desktop packaging.
- Added the Windows portable build workflow.

## Versioning

Every user-visible release must update the `version` field in `package.json` and add a matching entry here before packaging. `electron-builder` uses that package version for the Windows artifact name.
- Added an offline case-resume preparation checkpoint that validates a saved continuation proposal against the frozen protocol, reads authoritative repository state, preserves exhausted task history, and performs zero model calls, approvals, or experiment starts.
- Added an explicit offline plan-commit command that promotes a saved proposal to a new superseding plan while preserving the previous plan, budget ledger, failed attempts, and approval boundaries.
