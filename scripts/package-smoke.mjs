import { access, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.cwd());
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const required = [
  "dist/src/capture.js",
  "dist/src/backup-queue.js",
  "dist/src/services.js",
  "dist/src/provider.js",
  "dist/src/model-usage.js",
  "dist/src/research/model-budget-proxy.js",
  "dist/src/config.js",
  "dist/src/harness.js",
  "dist/src/workspace.js",
  "dist/src/integrity.js",
  "dist/src/startup-diagnostics.js",
  "dist/src/recovery.js",
  "dist/src/owned-process.js",
  "dist/src/process-owner.js",
  "dist/src/research/repository.js",
  "dist/src/research/source-content.js",
  "dist/src/research/reading-recovery.js",
  "dist/src/research/source-adapters.js",
  "dist/src/research/evidence-review.js",
  "dist/src/research/search-log.js",
  "dist/src/research/inspect.js",
  "dist/src/research/orchestrator.js",
  "dist/src/research/runner.js",
  "dist/src/research/dsh-sdk.js",
  "dist/src/research/task-result.js",
  "dist/src/research/result-references.js",
  "dist/src/research/result-commit.js",
  "dist/src/research/task-contract.js",
  "dist/src/research/hypothesis.js",
  "dist/src/research/experiment-design.js",
  "dist/src/research/code-staging.js",
  "dist/src/research/code-review.js",
  "dist/src/research/code-syntax.js",
  "dist/src/research/experiment.js",
  "dist/src/research/source-relation.js",
  "dist/src/research/design-review.js",
  "dist/src/research/report-review.js",
  "dist/src/research/budget.js",
  "desktop/main.mjs",
  "desktop/capture-dashboard.mjs",
  "desktop/capture-preload.cjs",
  "desktop/research-dashboard.mjs",
  "desktop/research-access.mjs",
  "desktop/research-readonly.mjs",
  "desktop/research-preload.cjs",
  "desktop/research-case-dashboard.mjs",
  "desktop/research-case-preload.cjs",
  "dist/src/research/store-format.js",
  "dist/src/research/migration.js",
  "desktop/startup-preload.cjs",
  "desktop/provider-profile.mjs",
  "desktop/dsh-sci-lifecycle-plugin.mjs",
  "desktop/dsh-sci-research-plugin.mjs",
  "scripts/research-source-live.mjs",
  "scripts/release-audit.mjs",
  "scripts/recovery-audit.mjs",
  "scripts/recovery-restore.mjs",
  "scripts/research-store-migrate.mjs",
];
const missing = [];
for (const relative of required) {
  try { await access(path.join(root, relative)); }
  catch { missing.push(relative); }
}
const files = new Set(packageJson.build?.files ?? []);
const expectedRules = ["desktop/**/*", "dist/src/**/*", "node_modules/**/*", "package.json"];
const missingRules = expectedRules.filter((rule) => !files.has(rule));
const forbiddenRules = ["!**/.env.local", "!dsh-sci.config.json", "!config{,/**}", "!research{,/**}", "!desktop/capture-preload.mjs"];
const missingExclusions = forbiddenRules.filter((rule) => !files.has(rule));
if (missing.length || missingRules.length || missingExclusions.length) {
  if (missing.length) console.error(`Missing build output: ${missing.join(", ")}`);
  if (missingRules.length) console.error(`Missing electron-builder file rule: ${missingRules.join(", ")}`);
  if (missingExclusions.length) console.error(`Missing sensitive-file exclusion: ${missingExclusions.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`Package smoke passed: ${required.length} runtime files, ${expectedRules.length} inclusion rules, and ${forbiddenRules.length} sensitive-file exclusions are present.`);
}
