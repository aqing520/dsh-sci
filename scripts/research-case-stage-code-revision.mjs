import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ResearchRepository } from "../dist/src/research/repository.js";
import { ResearchOrchestrator } from "../dist/src/research/orchestrator.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caseDirectory = path.join(root, "research/validation/cases/imputation-v1-1793358639679");
const workspaceRoot = path.join(caseDirectory, "runtime/workspace");
const repository = new ResearchRepository(path.join(caseDirectory, "runtime/research"));
let [project] = await repository.listProjects(10_000);
if (!project) throw new Error("Main case project not found");
let snapshot = await repository.exportProject(project.projectId);
let task = snapshot.plan.tasks.find((item) => item.taskId === "task-06");
if (!task || task.status !== "waiting-approval") throw new Error(`task-06 must await approval; found ${task?.status ?? "missing"}`);
const activated = await new ResearchOrchestrator(repository).approveTask(project.projectId, "task-06");
project = activated.project;
snapshot = await repository.exportProject(project.projectId);
task = snapshot.plan.tasks.find((item) => item.taskId === "task-06");
const design = snapshot.experimentDesigns.find((item) => item.designId === "design-e395adaad3d94137b8bb0c4e34dcc2335744fef7bb9ae2cc60e5d0e65e546cca");
if (!design || design.contentHash !== "d8816644ccdab884e636cac3bb258f465c5ecbfa62190e73c839b9b2f23aae85") throw new Error("Current design binding changed");
const baseId = "bundle-66a9911da0e1bc682578947827be04143aef9f3eaa5676e228f7800e345f0d01";
const base = snapshot.codeBundles.find((item) => item.bundleId === baseId);
if (!base) throw new Error("Base bundle not found");
const files = Object.fromEntries(await Promise.all(base.files.map(async (file) => [file.name, await readFile(file.path, "utf8")])))
const digest = (text) => createHash("sha256").update(text).digest("hex");

let run = files["run.mjs"];
run = run.replace("import crypto from 'node:crypto';", "import crypto from 'node:crypto';\nimport { fileURLToPath } from 'node:url';");
const helperAnchor = "function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value)); }\n\nensureDir(OUT);";
const helpers = [
  "function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value)); }",
  "function writeJsonAtomic(file, value) { const temp = file + '.tmp-' + process.pid + '-' + Date.now(); fs.writeFileSync(temp, JSON.stringify(value)); fs.renameSync(temp, file); }",
  "function assertFinite(value, label) { if (!Number.isFinite(value)) throw new Error('non-finite:' + label); }",
  "function validateReplicateRows(distribution, replicate, x, masks, rows) {",
  "  if (x.length !== CFG.n || x.some((value) => !Number.isFinite(value))) throw new Error('invalid-data:' + distribution + '/' + replicate);",
  "  if (rows.length !== CFG.rates.length) throw new Error('invalid-rate-count:' + distribution + '/' + replicate);",
  "  const seen = new Set();",
  "  for (const row of rows) {",
  "    const rate = row.p.toFixed(2); if (seen.has(rate)) throw new Error('duplicate-rate:' + rate); seen.add(rate);",
  "    const expectedMissing = Math.floor(CFG.n * row.p); const missing = masks[rate];",
  "    if (!Array.isArray(missing) || missing.length !== expectedMissing || row.nMissing !== expectedMissing || row.nObserved !== CFG.n - expectedMissing || row.valid !== true) throw new Error('invalid-counts:' + distribution + '/' + replicate + '/' + rate);",
  "    const unique = new Set(missing); if (unique.size !== missing.length || missing.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= CFG.n)) throw new Error('invalid-mask:' + distribution + '/' + replicate + '/' + rate);",
  "    for (const metric of ['MSE', 'MAE']) for (const key of ['mean', 'median', 'difference']) assertFinite(row[metric][key], metric + '/' + rate + '/' + key);",
  "  }",
  "}",
  "function validateAllReplicates(rows) { const expected = CFG.distributions.length * CFG.repetitions * CFG.rates.length; if (rows.length !== expected) throw new Error('replicate-row-count'); const keys = new Set(); for (const row of rows) { const key = row.distribution + '/' + row.replicate + '/' + row.p.toFixed(2); if (keys.has(key)) throw new Error('duplicate-replicate-row:' + key); keys.add(key); } }",
  "function writeRunStatus(status, error) { fs.writeFileSync(path.join(OUT, 'run-status.json'), JSON.stringify({ status, ...(error ? { error: String(error) } : {}), updatedAt: new Date().toISOString() })); }",
  "ensureDir(OUT); writeRunStatus('running'); process.on('exit', (code) => { if (code !== 0) { try { writeRunStatus('failed', 'process-exit:' + code); } catch {} } });",
].join("\n");
if (!run.includes(helperAnchor)) throw new Error("run helper anchor missing");
run = run.replace(helperAnchor, helpers);
const oldData = "    writeJson(path.join(OUT, `data-${distribution}-${replicate}.json`), { distribution, replicate, x, masks });";
if (!run.includes(oldData)) throw new Error("run data anchor missing");
run = run.replace(oldData, "    validateReplicateRows(distribution, replicate, x, masks, rows);\n    writeJsonAtomic(path.join(OUT, `data-${distribution}-${replicate}.json`), { distribution, replicate, x, masks });");
const oldRows = "    const rows = all.slice(0, count);\n    const meanLosses";
if (!run.includes(oldRows)) throw new Error("run summary anchor missing");
run = run.replace(oldRows, "    if (all.length !== CFG.repetitions || all.some((row) => row.valid !== true)) throw new Error('invalid-replicate-set:' + distribution + '/' + p);\n    const rows = all.slice(0, count);\n    if (rows.length !== count) throw new Error('insufficient-replicates:' + distribution + '/' + p + '/' + count);\n    const meanLosses");
const oldPush = "      delta, relative: meanLoss === 0 ? null : delta / meanLoss, ...boot,\n      status: count < 30 ? 'inconclusive/review' : (metric === 'MAE' ? 'exploratory' : 'primary-or-exploratory-by-condition') });";
const newPush = "      delta, relative: meanLoss === 0 ? null : delta / meanLoss, absoluteRelativeEffect: meanLoss === 0 ? null : Math.abs(delta / meanLoss), threshold: 0.02, thresholdDecision: (() => { const relative = meanLoss === 0 ? null : delta / meanLoss; const ci = boot.relativeCI; const pointEstimateExceeds = relative !== null && Math.abs(relative) >= 0.02; const intervalExcludesThreshold = Array.isArray(ci) && (ci[0] > 0.02 || ci[1] < -0.02); return { pointEstimateExceeds, intervalExcludesThreshold, uncertain: ci === null || (pointEstimateExceeds && !intervalExcludesThreshold) }; })(), ...boot,\n      status: count < 30 ? 'inconclusive/review' : (metric === 'MAE' ? 'exploratory' : 'primary-or-exploratory-by-condition') });";
if (!run.includes(oldPush)) throw new Error("run push anchor missing");
run = run.replace(oldPush, newPush);
const oldFinal = "writeJson(path.join(OUT, 'replicates.json'), replicates);\nwriteJson(path.join(OUT, 'summary.json'), summary);\nwriteJson(path.join(OUT, 'seeds.json'), seeds);\nconst manifest = {};\nfor (const file of fs.readdirSync(OUT).filter(f => f.endsWith('.json')).sort()) manifest[file] = sha256File(path.join(OUT, file));\nwriteJson(path.join(OUT, 'sha256-manifest.json'), manifest);\nconsole.log(`Prepared outputs in ${OUT}; execution is permitted only after Workspace approval.`);";
const newFinal = "validateAllReplicates(replicates);\nconst bundleDir = path.dirname(fileURLToPath(import.meta.url));\nconst bundleManifest = Object.fromEntries(['config.json', 'environment.json', 'README.md', 'run.mjs', 'validate.mjs'].map((file) => [file, sha256File(path.join(bundleDir, file))]));\nwriteJsonAtomic(path.join(OUT, 'replicates.json'), replicates);\nwriteJsonAtomic(path.join(OUT, 'summary.json'), summary.map((row) => ({ ...row, bundleManifest, baseBundleContentHash: CFG.baseBundleContentHash ?? null })));\nwriteJsonAtomic(path.join(OUT, 'seeds.json'), seeds);\nconst manifest = { manifestSelfExcluded: true, bundleManifest, outputFiles: {} };\nfor (const file of fs.readdirSync(OUT).filter(f => f.endsWith('.json') && f !== 'sha256-manifest.json' && f !== 'run-status.json').sort()) manifest.outputFiles[file] = sha256File(path.join(OUT, file));\nwriteJsonAtomic(path.join(OUT, 'sha256-manifest.json'), manifest);\nwriteRunStatus('completed');\nconsole.log(`Prepared outputs in ${OUT}; execution is permitted only after Workspace approval.`);";
if (!run.includes(oldFinal)) throw new Error("run final anchor missing");
run = run.replace(oldFinal, newFinal);

let validate = files["validate.mjs"];
validate = validate.replace("if (cfg.maskRule !== 'fixed-count-fisher-yates' || cfg.relativeDenominator !== 'mean') throw new Error('analysis contract mismatch');", "if (cfg.maskRule !== 'fixed-count-fisher-yates' || cfg.relativeDenominator !== 'mean' || cfg.executionStatus !== 'prepared-only; do-not-execute-before-workspace-approval' || !/^[a-f0-9]{64}$/u.test(cfg.protocolSha256) || !/^[a-f0-9]{64}$/u.test(cfg.sourceSha256 ?? '')) throw new Error('analysis or approval contract mismatch');");
validate = validate.replace("if (new Set(names).size !== names.length) throw new Error('label collision');", "if (new Set(names).size !== names.length || names.some((name) => !/^(data\\/[^/]+\\/[1-9][0-9]*|mask\\/[^/]+\\/[1-9][0-9]*\\/0\\.(10|30|50)|bootstrap(-control8)?\\/[^/]+\\/0\\.(10|30|50)\\/(MSE|MAE))$/u.test(name))) throw new Error('label contract mismatch');");
const config = JSON.parse(files["config.json"]);
config.sourceSha256 = digest(run); config.baseBundleContentHash = base.contentHash; config.threshold = 0.02;
files["config.json"] = JSON.stringify(config, null, 2) + "\n"; files["run.mjs"] = run; files["validate.mjs"] = validate;
const staged = await new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot } }).stageCode(project.projectId, { baseBundleId: baseId, files: [
  { name: "config.json", kind: "input", content: files["config.json"] },
  { name: "run.mjs", kind: "code", content: files["run.mjs"] },
  { name: "validate.mjs", kind: "code", content: files["validate.mjs"] },
] });
console.log(JSON.stringify({ schema: "dsh-sci.code-revision-staged.v1", projectId: project.projectId, planId: project.planId, designId: design.designId, baseBundleId: baseId, newBundleId: staged.bundleId, newBundleContentHash: staged.contentHash, files: staged.files.map(({ name, kind, bytes, contentHash }) => ({ name, kind, bytes, contentHash })), executed: false }, null, 2));
