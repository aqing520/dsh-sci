import { createHash } from "node:crypto";

export function caseProtocolDigest(protocol) {
  return createHash("sha256").update(JSON.stringify(protocol)).digest("hex");
}

export function parseCaseLiveArgs(args) {
  const options = { planFrom: undefined, sourceHints: [] };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!["--plan-from", "--source-hint"].includes(flag) || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Usage: research-case-live.mjs [--plan-from <previous-case/plan.json>] [--source-hint <https-url>] (repeatable, max 5)");
    const value = args[++index];
    if (flag === "--plan-from") {
      if (options.planFrom) throw new Error("--plan-from may only be supplied once");
      options.planFrom = value;
    } else {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || value.length > 1000) throw new Error("Source hints must be HTTPS URLs without credentials, maximum 1000 characters");
      if (!options.sourceHints.includes(url.href)) options.sourceHints.push(url.href);
      if (options.sourceHints.length > 5) throw new Error("At most five supplemental source hints are allowed");
    }
  }
  return options;
}

export function appendCaseSourceHints(question, sourceHints) {
  if (!sourceHints.length) return question;
  return [question,
    "SUPPLEMENTAL OPERATOR-SUPPLIED DISCOVERY HINTS (not autonomous discovery or verified evidence):",
    ...sourceHints.map((url) => `- ${url}`),
    "These hints supplement the frozen seed list without changing the experimental protocol or task objectives. Prefer an accessible publisher full text over an access challenge for the same paper; versions of one work count as one source. Retrieve, read and cite actual text, assess relevance and save access/coverage limitations. Do not count a browser challenge as scientific evidence. No research approval is granted by these hints.",
  ].join("\n");
}

// Replay objectives and measurable criteria, never persisted execution identity,
// output references, approval state, or stale task permissions.
export function replayCasePlanInput(saved, sourceHints = []) {
  return {
    question: appendCaseSourceHints(saved.question, sourceHints), title: saved.title,
    constraints: saved.constraints ? structuredClone(saved.constraints) : undefined,
    tasks: saved.tasks.map(({ taskId, title, objective, kind, dependsOn, requiresApproval, maxAttempts, successCriteria }) => ({
      taskId, title, objective, kind, dependsOn: dependsOn ? [...dependsOn] : [], requiresApproval, maxAttempts,
      successCriteria: successCriteria ? [...successCriteria] : undefined,
    })),
  };
}

// The benchmark is supplied verbatim. A prose digest previously omitted the
// fixed-count mask and mean-loss denominator, silently changing the experiment.
export function caseProtocolBinding(protocol) {
  return `Frozen protocol SHA-256: ${caseProtocolDigest(protocol)}\nBEGIN FROZEN PROTOCOL JSON\n${JSON.stringify(protocol, null, 2)}\nEND FROZEN PROTOCOL JSON`;
}

export function inspectCaseProtocolBinding(protocol, question) {
  const bound = typeof question === "string" && question.includes(caseProtocolBinding(protocol));
  return {
    schema: "dsh-sci.research-case-protocol-binding.v1",
    protocolSha256: caseProtocolDigest(protocol),
    status: bound ? "bound" : "review-required",
    scope: "Exact protocol propagation only; design/code compliance and scientific interpretation still require review.",
    issues: bound ? [] : ["Project question does not include the complete frozen protocol and its hash. Do not resume this historical case as a protocol-compliant run; preserve it and start a new case with the full protocol."],
  };
}

export function buildCaseQuestion(protocol, searchConfigured) {
  return [
    protocol.question,
    caseProtocolBinding(protocol),
    "The JSON is authoritative. Do not replace fixed-count Fisher-Yates masks with Bernoulli missingness. Use independent mask streams for each distribution/replicate/fraction. The practical effect denominator is mean-imputation loss, not median-imputation loss. Record signed delta and signed relative delta/meanLoss; assess the 2% threshold using its magnitude and uncertainty. Never change these rules in a clarify task; flag any conflict for review.",
    "Implementation details to freeze in the candidate design: FNV-1a32 of ASCII master+'/'+label; standard mulberry32 (including seed zero); Box-Muller using 1-U for the radius; descending Fisher-Yates swaps j=floor(U*(i+1)). Labels: data/{distribution}/{replicate}, mask/{distribution}/{replicate}/{p.toFixed(2)}, bootstrap/{distribution}/{p.toFixed(2)}/{metric}, bootstrap-control8/{distribution}/{p.toFixed(2)}/{metric}. Record all stream labels/seeds and stop on collisions. Missing indices are the first floor(n*p) entries of the independently shuffled indices; both methods share those indices.",
    "For independent replay, propose outputs (do not execute before approval): config.json containing {designId,protocolSha256,cfg:{n,repetitions,B:10000,master,distributions,rates,maskRule:'fixed-count-fisher-yates',relativeDenominator:'mean'},environment,sourceSha256}; data-{distribution}-{replicate}.json containing {distribution,replicate,x,masks}, where masks[String(p)] is the array of missing indices; replicates.json rows {distribution,replicate,p,valid,nObserved,nMissing,MSE:{mean,median,difference},MAE:{mean,median,difference}}; summary.json entries for every distribution/rate/metric/count in [100,8], with {distribution,p,metric,requestedReplicates,replicates,meanLoss,medianLoss,delta,relative,ci,relativeCI,status}. Use one-based replicate IDs. Bootstrap 10000 paired draws, quantiles at (B-1)*q with linear interpolation, recomputing signed ratio (sumMean-sumMedian)/sumMean in each draw; ratio and relativeCI are null on zero denominator. Always mark the eight-repeat control inconclusive/review. Save seeds, checks, environment, raw outputs and SHA-256 manifest. The output contract does not authorize execution.",
    `Read at least ${protocol.literature.minimumIndependentSources} independent sources, starting discovery hints: ${protocol.literature.seedReferences.join(", ")}. Hints are not verified evidence. ${searchConfigured ? "A configured search provider is available." : "General search is not configured; reference retrieval is available; record this coverage limitation."}`,
    `Plan literature reading, falsifiable hypotheses, design, code proposal, experiment, evaluation, iteration decision, report and research memory. Preserve citations and evidence. Stop for Workspace approval before running commands; no approval is provided in this baseline. If a capability is missing, record blocked/needs-approval without inventing results. Reading literature needs no approval. Limit to ${protocol.budget.maxTaskExecutions} tasks, maxAttempts=${protocol.budget.maxTaskAttempts}, maxIterations=${protocol.stopping.maxResearchIterations}.`,
  ].join("\n");
}

export function assertCaseReplayConfig(protocol, config) {
  const cfg = config?.cfg;
  const expected = {
    n: protocol.data.sampleSize,
    repetitions: protocol.data.independentReplicates,
    B: 10000,
    master: protocol.data.seed,
    distributions: protocol.data.distributions.map((item) => item.name),
    rates: protocol.data.missingFractions,
    maskRule: "fixed-count-fisher-yates",
    relativeDenominator: "mean",
  };
  const issues = Object.entries(expected).filter(([key, value]) => JSON.stringify(cfg?.[key]) !== JSON.stringify(value)).map(([key]) => `cfg.${key} differs from the frozen protocol/replay contract`);
  if (config?.protocolSha256 !== caseProtocolDigest(protocol)) issues.push("output protocolSha256 does not match the frozen protocol");
  if (issues.length) throw new Error(`Protocol review required: ${issues.join("; ")}`);
  return cfg;
}
