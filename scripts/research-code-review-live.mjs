// Real model static inspection of an operator-imported, previously model-written
// candidate. Imports are hash checked; no original state or approvals are copied.
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderConfig } from "../dist/src/provider.js";
import { ResearchRepository } from "../dist/src/research/repository.js";
import { ResearchOrchestrator } from "../dist/src/research/orchestrator.js";
import { stageResearchCode } from "../dist/src/research/code-staging.js";
import { codeReadsCoverFiles, readStagedCodeFile } from "../dist/src/research/code-review.js";
import { runResearchWithDshAgent } from "../dist/src/research/dsh-sdk.js";
import { startCaseProviderProxy } from "./research-case-provider.mjs";
import { buildCaseQuestion, caseProtocolBinding } from "./research-case-protocol.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const revise = args.at(-1) === "--revise";
if (revise) args.pop();
if (args.length < 2 || args[0] !== "--case" || (args.length !== 2 && (args.length !== 4 || args[2] !== "--candidate-dir"))) throw new Error("Usage: research-code-review-live.mjs --case <finished-case-directory> [--candidate-dir <candidate-directory>] [--revise]");
const sourceCase = await realpath(path.resolve(args[1]));
const candidateDirectory = args.length === 4 ? await realpath(path.resolve(args[3])) : undefined;
const casesRoot = await realpath(path.join(root, "research/validation/cases"));
const relative = path.relative(casesRoot, sourceCase);
if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Candidate case must be inside the case evidence directory");
const sourceRepository = new ResearchRepository(path.join(sourceCase, "runtime/research"));
const sourceSummary = JSON.parse(await readFile(path.join(sourceCase, "summary.json"), "utf8"));
if (!sourceSummary.finishedAt || !sourceSummary.projectId) throw new Error("Only a finished case may supply a candidate");
const sourceSnapshot = await sourceRepository.exportProject(sourceSummary.projectId);
const sourceBundleIds = sourceSnapshot.plan.tasks.filter((task) => task.kind === "code-preparation" && task.status === "completed").flatMap((task) => task.outputRefs);
const sourceBundle = sourceSnapshot.codeBundles.find((bundle) => sourceBundleIds.includes(bundle.bundleId));
if (!sourceBundle) throw new Error("Case has no completed-task code bundle to inspect");
const sourceBefore = JSON.stringify(sourceSnapshot);
const hash = (value) => createHash("sha256").update(value).digest("hex");
let revision;
let inputFiles;
if (candidateDirectory) {
  const evidenceRoot = await realpath(path.join(root, "research/validation"));
  const relativeCandidate = path.relative(evidenceRoot, candidateDirectory);
  if (relativeCandidate.startsWith("..") || path.isAbsolute(relativeCandidate)) throw new Error("Revised candidates must remain in the validation evidence directory");
  revision = JSON.parse(await readFile(path.join(candidateDirectory, "revision.json"), "utf8"));
  if (revision.sourceBundleId !== sourceBundle.bundleId || revision.author !== "operator" || revision.candidateCodeExecuted !== false || !Array.isArray(revision.files) || !revision.files.length || revision.files.length > 20) throw new Error("Invalid explicit candidate revision provenance");
  if (revision.correctiveRequirements !== undefined && (!revise || !Array.isArray(revision.correctiveRequirements) || revision.correctiveRequirements.length < 1 || revision.correctiveRequirements.length > 16 || revision.correctiveRequirements.some((item) => typeof item !== "string" || !item.trim() || item.length > 2400))) throw new Error("Corrective requirements require revision mode and 1 to 16 bounded operator observations");
  inputFiles = await Promise.all(revision.files.map(async (file) => {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(file.name)) throw new Error("Candidate import requires flat, explicit file names");
    const target = path.join(candidateDirectory, file.name);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 128 * 1024) throw new Error("Invalid candidate revision file");
    const bytes = await readFile(target);
    if (hash(bytes) !== file.contentHash) throw new Error("Revised candidate changed since revision manifest");
    return { name: file.name, kind: file.kind, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  }));
} else inputFiles = await Promise.all(sourceBundle.files.map(async (file) => ({ name: file.name, kind: file.kind, content: await readStagedCodeFile(path.join(sourceCase, "runtime/workspace"), sourceBundle, file.name) })));
const protocol = JSON.parse(await readFile(path.join(sourceCase, "protocol.json"), "utf8"));
const output = path.join(root, "research/validation", `${revise ? "code-revision-live" : "code-review-live"}-${Date.now()}`);
const runtime = path.join(output, "runtime"), workspace = path.join(runtime, "workspace");
await mkdir(workspace, { recursive: true });
const repository = new ResearchRepository(path.join(runtime, "research"));
const orchestrator = new ResearchOrchestrator(repository, {}, undefined, { experimentPolicy: { workspaceRoot: workspace } });
const wallTimeMs = revise ? 720000 : 360000;
const taskTimeoutMs = revise ? 360000 : 240000;
const maxTokens = revise ? 10000 : 4096;
const controller = new AbortController(), timer = setTimeout(() => controller.abort(), wallTimeMs);
const summary = { schema: "dsh-sci.code-review-live.v1", startedAt: new Date().toISOString(), status: "not-started", scientificQuality: "not-reviewed",
  scope: "Real SDK static review of a verified operator-imported candidate against its frozen protocol. Import and single-task plan are operator supplied. A revision, when present, is operator-authored and does not constitute autonomous research. Original design/hypothesis records are comparison context only, not authoritative bindings in the probe. Not full research or correctness acceptance.",
  humanActions: [], operatorActions: [{ action: "import-hash-verified-candidate", sourceCase: path.relative(root, sourceCase).replaceAll("\\", "/"), ...(candidateDirectory ? { candidateDirectory: path.relative(root, candidateDirectory).replaceAll("\\", "/"), revision } : {}), sourceBundleId: sourceBundle.bundleId, files: inputFiles.map(({ name, kind, content }) => ({ name, kind, bytes: Buffer.byteLength(content), contentHash: hash(content) })), grantsApproval: false }],
  generatedCodeExecuted: false, revisionMode: revise, budget: { maxModelRequests: revise ? 24 : 16, maxModelTokens: revise ? 700000 : 500000, maxTaskExecutions: revise ? 2 : 1, maxWallTimeMs: wallTimeMs }, codeHashes: {} };
if (revise) {
  summary.scope = "Real SDK candidate revision followed by static review in a separate project. Imported files and corrective requirements are operator inputs; the revised candidate must be staged by the model. No prior task status/design approval is imported. This isolated revision does not establish full-case autonomy, code correctness or scientific acceptance.";
  summary.resourceConfiguration = { taskTimeoutMs, maxOutputTokensPerRequest: maxTokens, note: "Independent two-task revision probe with explicit resources; no old project budget or frozen full-case budget is changed." };
}
let config, proxy, projectId, phase = "runtime-hashes";
const save = async (name, value) => {
  let text = JSON.stringify(value, null, 2);
  for (const secret of [config?.apiKey, proxy?.apiKey].filter(Boolean)) for (const representation of [secret, JSON.stringify(secret).slice(1, -1)]) text = text.split(representation).join("[REDACTED]");
  await writeFile(path.join(output, name), text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]") + "\n");
};
try {
  for (const file of ["domain", "code-review", "code-staging", "task-contract", "orchestrator", "repository", "bridge", "dsh-sdk", "result-references"]) summary.codeHashes[`dist/src/research/${file}.js`] = hash(await readFile(path.join(root, `dist/src/research/${file}.js`)));
  phase = "provider-config";
  config = await loadProviderConfig({ workspace: root });
  if (!config.apiKey?.trim()) throw new Error("No model provider key configured");
  summary.provider = config.provider; summary.model = config.model;
  phase = "provider-proxy";
  proxy = await startCaseProviderProxy({ config, budget: { maxModelRequests: summary.budget.maxModelRequests, maxOutputTokensPerRequest: maxTokens, taskTimeoutMs }, signal: controller.signal });
  const question = revise ? [buildCaseQuestion(protocol, false),
    "This is only the candidate revision and static review segment in a new project, with an operator-provided two-task plan. Prior designs/hypotheses are external comparison context, not registered here. No literature collection, design approval, code execution or numerical results are authorized. The source candidate was imported for code-read and comparison. Create a new complete immutable bundle authored by you; do not treat the import as task completion.",
    ...(revision?.correctiveRequirements ? [] : ["CORRECTIVE REQUIREMENTS (operator observations, not review approval): numeric cfg.master; masks[String(p)] arrays while stream labels retain p.toFixed(2); detect two different labels with identical uint32 seeds as well as duplicate labels; cfg.environment must contain actual process.version/versions/platform/arch at execution time, never copied unobserved claims. Preserve raw delta CI even if any bootstrap relative denominator is zero: relativeCI=null for that entire interval, do not discard zero-denominator draws or abort the raw interval. Select/validate exact one-based replicate identities 1..count; the eight-repeat control takes replicates 1..8 from the full 100-row table and still computes its intervals while status remains inconclusive/review. Reject duplicates/missing/invalid/nonfinite rows. Tests must call actual exported implementation functions with independent expected values and edge-case inputs, not regex checks of source text or duplicated implementations. Include zero-seed RNG, fixed mask count/uniqueness, observed-only fitting, even median, seed collision, quantiles, zero denominators and eight-repeat interval/status tests. Importing the pure module must not run the full simulation or write files. Use new URL('./environment.json', import.meta.url), not URL.pathname for Windows file paths. Save complete sources, test sources, protocol and environment declarations in ONE final bundle; modules are fine. Clearly document that manifest excludes itself (self-hashing is impossible); sourceSha256 must hash run.mjs, with additional module/test hashes persisted separately. Record 0.02 practical effect separately from interval exclusion and never turn non-significance into equivalence. At execution validate input protocol and make output-directory reuse fail rather than include stale files."]),
    `External comparison design ID (unapproved and not registered in this probe): ${sourceSnapshot.experimentDesigns[0]?.designId ?? "none"}`,
    ...(revision?.priorFindings ? [`Previous Agent findings (unreviewed suggestions; verify against imported source): ${JSON.stringify(revision.priorFindings.map(({ fileName, message }) => ({ fileName, message: message.slice(0, 340) })))}`] : []),
    ...(revision?.correctiveRequirements ? [] : ["Additional independent checks: test expectations must have the correct types and numeric precision; manually work small examples (fill=3 for truth [1,5] gives squared error 4 and absolute error 2). Test observed-only fitting through the exported fitting function, distinct-label seed collision via an injectable hash or explicit registration, and summarize(count=8) against a table of 100 valid paired repeats. Exact protocol validation must include distributions=['lognormal','normal'], rates=[0.1,0.3,0.5] and frozen SHA. Keep full input protocol in the bundle if used. Additional module/test hashes must be in config, not only output manifest. Compile-only syntaxChecks are not execution; fix syntax failures before completing preparation. Keep external design ID explicitly unapproved (no placeholder design ID).",
    "The authoritative protocol is the COMPLETE frozen JSON in the research question, including data/analysis/stopping/budget/literature/approval/requiredArtifacts; a reduced configuration with a copied protocolSha256 is not that protocol. Preserve the full object in protocol.json, recompute SHA256(JSON.stringify(parsedProtocol)) against the frozen SHA, validate the generation/analysis settings and derive cfg from its data and analysis fields. Do not add a protocolSha256 field inside the authoritative object and then claim its hash is unchanged. Include the full protocol file as an input. Keep any external design ID explicitly pending, never approved.",
    "Verify the zero-seed RNG expectation independently, including all compared decimal digits; parsing and static reading are not test execution. Validate the complete 600-row (2 distributions x 3 rates x 100 replicates) simulation table before selecting any condition or 1..8 control; reject unexpected conditions, duplicate/missing identities and nonfinite/invalid metric fields, including signed difference inconsistency. Tests must cover rejection and the eight-repeat interval itself, not only its status; use a deterministic hand-computed non-degenerate bootstrap case and verify practical threshold separately from zero exclusion. Fix actual implementation and behavioral source together; do not replace numerical assertions with source-string assertions."]),
    ...(revision?.correctiveRequirements ? ["FOCUSED OPERATOR REVISION BRIEF (external findings, not autonomous discoveries or approval):", ...revision.correctiveRequirements, "Use baseBundleId to inherit unchanged verified files; supply complete contents only for changed/new files. Preserve the complete frozen protocol and avoid unrelated rewrites. Recheck each numeric assertion by hand before saving. This task remains preparation and static review only; do not execute tests or experiments."] : []),
  ].join("\n") : ["Inspect the imported candidate against the frozen protocol using static reading only. Do not execute, approve or generate numerical results.", caseProtocolBinding(protocol),
    "Output contract: config.json must contain {designId,protocolSha256,cfg:{n,repetitions,B:10000,master,distributions,rates,maskRule:'fixed-count-fisher-yates',relativeDenominator:'mean'},environment,sourceSha256}. Data files contain {distribution,replicate,x,masks}, masks[String(p)] is the index array. Stream labels: data/{distribution}/{replicate}, mask/{distribution}/{replicate}/{p.toFixed(2)}, bootstrap/{distribution}/{p.toFixed(2)}/{metric}, bootstrap-control8/{distribution}/{p.toFixed(2)}/{metric}. FNV-1a32 hashes ASCII master+'/'+label; stop on seed collisions. Include test source for edge cases, but no tests are executed here.",
    `Original design (external comparison context only): ${JSON.stringify(sourceSnapshot.experimentDesigns)}`,
  ].join("\n");
  summary.inputCharacterCount = question.length;
  phase = "create-project";
  if (question.length > 16000) { summary.failureCode = "question-length"; throw new Error("Probe question exceeds the ordinary project input limit"); }
  const reviewTask = { taskId: "review", title: "Inspect candidate", kind: "code-review", maxAttempts: 1, dependsOn: revise ? ["revise"] : [],
    objective: "Read EVERY registered code/input/dependency file in the final candidate using code-read (follow nextOffset). If a revise task completed, use ONLY its output bundle for this review, not the older import. Compare implementation, real behavioral test source and output contract with the complete frozen protocol and corrective requirements. Record real discrepancies and unresolved checks with file ranges and recommendations using code-review. Do not claim code correctness, source support, human review, test success or execution. There is no registered design in this probe, so omit designId from the action. The external design ID inside the candidate is a pending comparison identifier only; it must not imply approval. Finish with the exact persisted codeReviewId and candidate bundleId in refs; findings may request revision without falsely approving anything." };
  const created = await orchestrator.createProject(question, { budget: summary.budget, plan: { question, tasks: [
    ...(revise ? [{ taskId: "revise", title: "Revise candidate and behavioral tests", kind: "code-preparation", maxAttempts: 1,
      objective: "Read every imported file using code-read, then implement the complete frozen protocol, output contract and corrective requirements in a NEW self-contained bundle. Save real behavioral test source alongside pure exported functions and a separate guarded run.mjs entrypoint. Do not execute any candidate or tests. A bundle containing only documentation/source-string assertions or the old import does not meet the objective. Prefer baseBundleId with changed complete files to inherit unchanged verified inputs; after success return the NEW exact bundleId in refs, with honest unexecuted limitations. Do not approve anything or call task-result yourself.",
      successCriteria: ["New model-staged bundle differs from the operator import and contains implementation, meaningful behavioral test source and input/dependency declarations", "All corrective requirements are reflected in complete source; no candidate or test is executed"] }] : []), reviewTask ] } });
  projectId = created.project.projectId; summary.projectId = projectId;
  // Trusted import is explicit, not an Agent tool capability or fake task result.
  phase = "import-candidate";
  const imported = await stageResearchCode(workspace, { projectId, planId: created.plan.planId, taskId: revise ? "revise" : "review" }, { files: inputFiles });
  await repository.saveCodeBundle(imported);
  summary.importedBundleId = imported.bundleId;
  phase = "run-agent";
  const result = await runResearchWithDshAgent(orchestrator, { projectId, sdkHome: path.join(runtime, "sdk-home"), pluginFile: path.join(root, "desktop/dsh-sci-research-plugin.mjs"), cwd: workspace,
    provider: config.provider, model: config.model, baseUrl: proxy.baseUrl, apiKey: proxy.apiKey, maxSteps: revise ? 2 : 1, maxModelSteps: revise ? 20 : 16, maxTokens, taskTimeoutMs, signal: controller.signal });
  summary.status = result.status; summary.reason = result.reason;
} catch (error) {
  summary.status = controller.signal.aborted ? "time-budget-exhausted" : "failed";
  summary.failureKind = error?.name ?? "Error";
  summary.failureStage = phase;
} finally {
  clearTimeout(timer); controller.abort(); await proxy?.close();
  if (projectId) {
    const snapshot = await repository.exportProject(projectId);
    await save("snapshot.json", snapshot);
    summary.productBudget = snapshot.budget;
    summary.tasks = snapshot.plan.tasks.map(({ taskId, status, attempts, outputRefs, error }) => ({ taskId, status, attempts, outputRefs, error }));
    summary.resultRepairs = snapshot.events.filter((event) => event.type === "task-result-repair-requested").map(({ taskId, data }) => ({ taskId, reason: data?.reason, repairAttempt: data?.repairAttempt }));
    summary.reviews = snapshot.codeReviews;
    summary.counts = { codeBundles: snapshot.codeBundles.length, codeReads: snapshot.codeReads.length, codeReviews: snapshot.codeReviews.length, experiments: snapshot.experiments.length, experimentRuns: snapshot.experimentRuns.length };
    const review = snapshot.codeReviews.length === 1 ? snapshot.codeReviews[0] : undefined;
    const reviewedBundle = review ? snapshot.codeBundles.find((bundle) => bundle.bundleId === review.bundleId) : undefined;
    const revisionTask = snapshot.plan.tasks.find((task) => task.taskId === "revise");
    summary.candidateAuthorship = revise ? "model-staged revision; operator-provided import and requirements" : candidateDirectory ? revision?.contentAuthorship === "model" ? "model-authored candidate selected and imported by operator" : "operator-authored revision" : "previous model candidate";
    summary.integrationPassed = summary.status === "completed" && Boolean(review && reviewedBundle && snapshot.plan.tasks.find((task) => task.taskId === "review")?.outputRefs.includes(review.codeReviewId) && codeReadsCoverFiles(review, reviewedBundle, review.files, snapshot.codeReads)) && (!revise || (review.bundleId !== summary.importedBundleId && revisionTask?.outputRefs.includes(review.bundleId))) && snapshot.experimentRuns.length === 0;
  }
  summary.originalCaseUnchanged = sourceBefore === JSON.stringify(await sourceRepository.exportProject(sourceSummary.projectId));
  if (!summary.originalCaseUnchanged) summary.integrationPassed = false;
  summary.providerCalls = proxy?.state; summary.finishedAt = new Date().toISOString();
  await save("summary.json", summary);
  console.log(JSON.stringify({ status: summary.status, integrationPassed: summary.integrationPassed ?? false, counts: summary.counts, evidence: output, scientificQuality: summary.scientificQuality }));
  if (!summary.integrationPassed) process.exitCode = 2;
}
