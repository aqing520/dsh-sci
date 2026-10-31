import { createHash, randomUUID } from "node:crypto";

export type EvaluationConclusion = "supports" | "refutes" | "inconclusive";

export interface EvaluationMetric {
  name: string;
  observed?: number;
  expected?: number;
  uncertainty?: number;
  unit?: string;
  sampleSize?: number;
  criterion?: EvaluationCriterion;
  tolerance?: number;
  lowerBound?: number;
  upperBound?: number;
  statistical?: StatisticalMetricInput;
  computed?: StatisticalMetricResult;
  pairedBootstrap?: PairedBootstrapInput;
  computedBootstrap?: PairedBootstrapResult;
}

export interface ResearchEvaluation {
  schema: "dsh-sci.research-evaluation.v1";
  evaluationId: string;
  projectId: string;
  /** Absent on historical records; these cannot drive a new automatic decision. */
  planId?: string;
  taskId?: string;
  experimentRunIds: string[];
  artifactIds: string[];
  metrics: EvaluationMetric[];
  conclusion: EvaluationConclusion;
  summary: string;
  limitations: string[];
  nextAction?: string;
  createdAt: string;
}

export type EvaluationCriterion = "at-least" | "at-most" | "close" | "in-range";

export type StatisticalMethod = "mean-difference" | "proportion-difference" | "confidence-interval" | "cohens-d" | "welch-t" | "mann-whitney-u";
export type StatisticalDirection = "positive" | "negative" | "two-sided";

export interface StatisticalMetricInput {
  method: StatisticalMethod;
  version?: "dsh-sci.stats.v1";
  treatmentMean?: number;
  treatmentStandardDeviation?: number;
  treatmentSampleSize?: number;
  controlMean?: number;
  controlStandardDeviation?: number;
  controlSampleSize?: number;
  treatmentSuccesses?: number;
  treatmentTrials?: number;
  controlSuccesses?: number;
  controlTrials?: number;
  treatmentValues?: number[];
  controlValues?: number[];
  estimate?: number;
  standardError?: number;
  confidenceLevel?: number;
  alpha?: number;
  direction?: StatisticalDirection;
}

export interface StatisticalMetricResult {
  schema: "dsh-sci.statistical-result.v1";
  method: StatisticalMethod;
  version: "dsh-sci.stats.v1";
  estimate: number;
  standardError?: number;
  lowerBound?: number;
  upperBound?: number;
  pValue?: number;
  effectSize?: number;
  confidenceLevel: number;
  alpha: number;
  direction: StatisticalDirection;
  conclusion: EvaluationConclusion;
  inputs: Record<string, number>;
  degreesOfFreedom?: number;
  reviewRequired: boolean;
  reviewReasons: string[];
}

export type BootstrapVersion = "dsh-sci.bootstrap.v1" | "dsh-sci.bootstrap.v2";

export interface PairedBootstrapInput {
  /** New computations default to v2; specify v1 only to replay legacy results. */
  version?: BootstrapVersion;
  differences: number[];
  resamples?: number;
  seed: number;
  confidenceLevel?: number;
  direction?: StatisticalDirection;
  /** Optional baseline magnitude used only for a practical relative threshold. */
  baselineMagnitude?: number;
  practicalRelativeThreshold?: number;
}

export interface PairedBootstrapResult {
  schema: "dsh-sci.paired-bootstrap-result.v1";
  method: "paired-percentile-bootstrap";
  version: BootstrapVersion;
  estimate: number;
  lowerBound: number;
  upperBound: number;
  confidenceLevel: number;
  sampleSize: number;
  resamples: number;
  seed: number;
  direction: StatisticalDirection;
  practicalRelativeDifference?: number;
  practicalRelativeThreshold?: number;
  conclusion: EvaluationConclusion;
  reviewRequired: boolean;
  reviewReasons: string[];
  inputs: { differenceHash: string };
}

export interface IndependentNumericCheck {
  schema: "dsh-sci.independent-numeric-check.v1";
  method: "absolute-and-relative-error";
  reported: number;
  recomputed: number;
  absoluteError: number;
  relativeError: number;
  tolerance: number;
  matches: boolean;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return value;
}

function positive(value: unknown, field: string): number {
  const result = finite(value, field);
  if (result <= 0) throw new Error(`${field} must be positive`);
  return result;
}

function nonNegative(value: unknown, field: string): number {
  const result = finite(value, field);
  if (result < 0) throw new Error(`${field} must be non-negative`);
  return result;
}

function sampleSize(value: unknown, field: string): number {
  const result = finite(value, field);
  if (!Number.isSafeInteger(result) || result < 2) throw new Error(`${field} must be an integer of at least 2`);
  return result;
}

function bounded(value: unknown, field: string, minimum: number, maximum: number): number {
  const result = finite(value, field);
  if (result < minimum || result > maximum) throw new Error(`${field} must be between ${minimum} and ${maximum}`);
  return result;
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * x);
  const polynomial = (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return 0.5 * (1 + sign * (1 - polynomial * Math.exp(-x * x)));
}

// Acklam's rational approximation is sufficient for confidence levels used in reports.
function normalQuantile(probability: number): number {
  const p = bounded(probability, "statistical confidence probability", Number.EPSILON, 1 - Number.EPSILON);
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const tail = (probability: number): number => {
    const q = Math.sqrt(-2 * Math.log(probability));
    const numerator = ((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5];
    const denominator = (((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1;
    return numerator / denominator;
  };
  if (p < 0.02425) return tail(p);
  if (p > 0.97575) return -tail(1 - p);
  const q = p - 0.5;
  const r = q * q;
  const numerator = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q;
  const denominator = ((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1;
  return numerator / denominator;
}

function logGamma(value: number): number {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  let x = 0.9999999999998099;
  const shifted = value - 1;
  for (let index = 0; index < coefficients.length; index += 1) x += coefficients[index] / (shifted + index + 1);
  const t = shifted + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIterations = 200;
  const epsilon = 3e-14;
  const tiny = 1e-300;
  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny; c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny; d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny; c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny; d = 1 / d;
    const delta = d * c; h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return h;
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const factor = Math.exp(a * Math.log(x) + b * Math.log1p(-x) - logGamma(a) - logGamma(b) + logGamma(a + b));
  return x < (a + 1) / (a + b + 2) ? factor * betaContinuedFraction(a, b, x) / a : 1 - factor * betaContinuedFraction(b, a, 1 - x) / b;
}

function studentTCdf(value: number, degreesOfFreedom: number): number {
  if (!Number.isFinite(value)) return value < 0 ? 0 : 1;
  const x = degreesOfFreedom / (degreesOfFreedom + value * value);
  const beta = regularizedBeta(x, degreesOfFreedom / 2, 0.5);
  return value >= 0 ? 1 - beta / 2 : beta / 2;
}

function values(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.length < 2) throw new Error(`${field} must contain at least 2 values`);
  return value.map((item, index) => finite(item, `${field}[${index}]`));
}

function bootstrapRng(seed: number, version: BootstrapVersion): () => number {
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("bootstrap seed must be a non-negative safe integer");
  if (version === "dsh-sci.bootstrap.v2" && seed > 0xffffffff) throw new Error("bootstrap v2 seed must be a uint32 integer");
  // v1 coerced large seeds and replaced zero. Preserve it only for explicit
  // historical replay; v2 implements mulberry32 with the actual uint32 seed.
  let state = version === "dsh-sci.bootstrap.v1" ? (seed >>> 0) || 0x6d2b79f5 : seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], probability: number): number {
  if (!sorted.length) throw new Error("cannot calculate a quantile from empty values");
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** Deterministic paired percentile bootstrap over one value per independent unit. */
export function evaluatePairedBootstrap(input: PairedBootstrapInput): PairedBootstrapResult {
  const version = input.version ?? "dsh-sci.bootstrap.v2";
  if (version !== "dsh-sci.bootstrap.v1" && version !== "dsh-sci.bootstrap.v2") throw new Error("unsupported paired bootstrap version");
  const differences = values(input.differences, "paired bootstrap differences");
  const resamples = input.resamples === undefined ? 10_000 : input.resamples;
  if (!Number.isSafeInteger(resamples) || resamples < 100 || resamples > 100_000) throw new Error("paired bootstrap resamples must be an integer from 100 to 100000");
  const confidenceLevel = input.confidenceLevel === undefined ? 0.95 : bounded(input.confidenceLevel, "bootstrap confidenceLevel", 0.5, 0.999);
  const direction = input.direction ?? "two-sided";
  const rng = bootstrapRng(input.seed, version);
  const estimate = differences.reduce((sum, value) => sum + value, 0) / differences.length;
  const bootstrapped = new Array<number>(resamples);
  for (let draw = 0; draw < resamples; draw += 1) {
    let total = 0;
    for (let index = 0; index < differences.length; index += 1) total += differences[Math.floor(rng() * differences.length)];
    bootstrapped[draw] = total / differences.length;
  }
  bootstrapped.sort((a, b) => a - b);
  const tail = (1 - confidenceLevel) / 2;
  const lowerBound = quantile(bootstrapped, tail);
  const upperBound = quantile(bootstrapped, 1 - tail);
  const reviewReasons: string[] = [];
  if (differences.length < 30) reviewReasons.push("Fewer than 30 paired repetitions; treat the interval as inconclusive and review power.");
  if (input.baselineMagnitude !== undefined && (!Number.isFinite(input.baselineMagnitude) || input.baselineMagnitude === 0)) throw new Error("bootstrap baselineMagnitude must be finite and non-zero");
  const practicalRelativeDifference = input.baselineMagnitude === undefined ? undefined : estimate / Math.abs(input.baselineMagnitude);
  const practicalRelativeThreshold = input.practicalRelativeThreshold;
  if (practicalRelativeThreshold !== undefined && (!Number.isFinite(practicalRelativeThreshold) || practicalRelativeThreshold < 0)) throw new Error("bootstrap practicalRelativeThreshold must be non-negative");
  const excludesZero = lowerBound > 0 || upperBound < 0;
  const directionPasses = direction === "positive" ? lowerBound > 0 : direction === "negative" ? upperBound < 0 : excludesZero;
  const practicalPasses = practicalRelativeThreshold === undefined || practicalRelativeDifference === undefined
    ? true
    : Math.abs(practicalRelativeDifference) >= practicalRelativeThreshold;
  if (practicalRelativeThreshold !== undefined && practicalRelativeDifference !== undefined && !practicalPasses) reviewReasons.push("The point estimate does not cross the pre-specified practical relative threshold.");
  const conclusion: EvaluationConclusion = differences.length < 30 || !directionPasses || !practicalPasses ? "inconclusive" : direction === "two-sided" ? (estimate > 0 ? "supports" : "refutes") : "supports";
  const differenceHash = createHash("sha256").update(JSON.stringify(differences)).digest("hex");
  return { schema: "dsh-sci.paired-bootstrap-result.v1", method: "paired-percentile-bootstrap", version, estimate, lowerBound, upperBound, confidenceLevel, sampleSize: differences.length, resamples, seed: input.seed, direction, ...(practicalRelativeDifference === undefined ? {} : { practicalRelativeDifference }), ...(practicalRelativeThreshold === undefined ? {} : { practicalRelativeThreshold }), conclusion, reviewRequired: reviewReasons.length > 0, reviewReasons, inputs: { differenceHash } };
}

function bootstrapInputForMetric(metric: EvaluationMetric): PairedBootstrapInput {
  const input = metric.pairedBootstrap!;
  if (input.version && metric.computedBootstrap && input.version !== metric.computedBootstrap.version) throw new Error("paired bootstrap input/result versions disagree");
  // Legacy evaluations saved the version only in the computed result. Reading
  // or evaluating those metrics must not silently select today's default.
  return { ...input, version: input.version ?? metric.computedBootstrap?.version ?? "dsh-sci.bootstrap.v2" };
}

/** Compare a reported number with an independently recomputed value. */
export function checkIndependentNumericResult(reported: number, recomputed: number, tolerance = 1e-9): IndependentNumericCheck {
  if (!Number.isFinite(reported) || !Number.isFinite(recomputed)) throw new Error("independent numeric values must be finite");
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("independent numeric tolerance must be non-negative");
  const absoluteError = Math.abs(reported - recomputed);
  const relativeError = absoluteError / Math.max(1, Math.abs(recomputed));
  return { schema: "dsh-sci.independent-numeric-check.v1", method: "absolute-and-relative-error", reported, recomputed, absoluteError, relativeError, tolerance, matches: absoluteError <= tolerance || relativeError <= tolerance };
}

function reviewMetadata(method: StatisticalMethod, sampleSizes: number[]): { reviewRequired: boolean; reviewReasons: string[] } {
  const reasons: string[] = [];
  if (sampleSizes.some((size) => size < 30)) reasons.push("Sample size is below 30; inspect power and uncertainty manually.");
  if (method === "welch-t") reasons.push("Confirm independence, scale interpretation, and approximate normality before accepting the t-test conclusion.");
  if (method === "mann-whitney-u") reasons.push("Review ties, independence, and whether the rank-based effect answers the research question.");
  return { reviewRequired: reasons.length > 0, reviewReasons: reasons };
}

function conclusionFor(estimate: number, pValue: number | undefined, direction: StatisticalDirection, alpha: number): EvaluationConclusion {
  if (pValue === undefined || pValue > alpha) return "inconclusive";
  if (direction === "positive") return estimate > 0 ? "supports" : "refutes";
  if (direction === "negative") return estimate < 0 ? "supports" : "refutes";
  return estimate > 0 ? "supports" : estimate < 0 ? "refutes" : "inconclusive";
}

/** Calculate a reproducible statistical result locally; models only explain it. */
export function evaluateStatisticalMetric(input: StatisticalMetricInput): StatisticalMetricResult {
  if (!input || typeof input !== "object" || !["mean-difference", "proportion-difference", "confidence-interval", "cohens-d", "welch-t", "mann-whitney-u"].includes(input.method)) throw new Error("statistical metric method is invalid");
  const confidenceLevel = input.confidenceLevel === undefined ? 0.95 : bounded(input.confidenceLevel, "statistical confidenceLevel", 0.5, 0.999);
  const alpha = input.alpha === undefined ? 1 - confidenceLevel : bounded(input.alpha, "statistical alpha", 0.0001, 0.5);
  const direction = input.direction ?? "two-sided";
  const inputs: Record<string, number> = {};
  let estimate: number;
  let standardError: number | undefined;
  let effectSize: number | undefined;
  let degreesOfFreedom: number | undefined;
  let reviewSampleSizes: number[] = [];
  if (input.method === "mean-difference" || input.method === "cohens-d" || input.method === "welch-t") {
    const treatmentMean = finite(input.treatmentMean, "treatmentMean"); const controlMean = finite(input.controlMean, "controlMean");
    const treatmentStandardDeviation = nonNegative(input.treatmentStandardDeviation, "treatmentStandardDeviation"); const controlStandardDeviation = nonNegative(input.controlStandardDeviation, "controlStandardDeviation");
    const treatmentSampleSize = sampleSize(input.treatmentSampleSize, "treatmentSampleSize"); const controlSampleSize = sampleSize(input.controlSampleSize, "controlSampleSize");
    Object.assign(inputs, { treatmentMean, controlMean, treatmentStandardDeviation, controlStandardDeviation, treatmentSampleSize, controlSampleSize });
    estimate = treatmentMean - controlMean;
    standardError = Math.sqrt((treatmentStandardDeviation ** 2 / treatmentSampleSize) + (controlStandardDeviation ** 2 / controlSampleSize));
    const pooled = Math.sqrt(((treatmentSampleSize - 1) * treatmentStandardDeviation ** 2 + (controlSampleSize - 1) * controlStandardDeviation ** 2) / (treatmentSampleSize + controlSampleSize - 2));
    effectSize = pooled > 0 ? estimate / pooled : undefined;
    reviewSampleSizes = [treatmentSampleSize, controlSampleSize];
    if (input.method === "welch-t") {
      const treatmentVariance = treatmentStandardDeviation ** 2 / treatmentSampleSize;
      const controlVariance = controlStandardDeviation ** 2 / controlSampleSize;
      const totalVariance = treatmentVariance + controlVariance;
      degreesOfFreedom = totalVariance > 0 ? (totalVariance ** 2) / ((treatmentVariance ** 2) / (treatmentSampleSize - 1) + (controlVariance ** 2) / (controlSampleSize - 1)) : undefined;
    }
  } else if (input.method === "proportion-difference") {
    const treatmentSuccesses = finite(input.treatmentSuccesses, "treatmentSuccesses"); const treatmentTrials = sampleSize(input.treatmentTrials, "treatmentTrials");
    const controlSuccesses = finite(input.controlSuccesses, "controlSuccesses"); const controlTrials = sampleSize(input.controlTrials, "controlTrials");
    if (treatmentSuccesses < 0 || treatmentSuccesses > treatmentTrials || controlSuccesses < 0 || controlSuccesses > controlTrials) throw new Error("proportion successes must be within trials");
    Object.assign(inputs, { treatmentSuccesses, treatmentTrials, controlSuccesses, controlTrials });
    const treatmentRate = treatmentSuccesses / treatmentTrials; const controlRate = controlSuccesses / controlTrials;
    estimate = treatmentRate - controlRate;
    standardError = Math.sqrt(treatmentRate * (1 - treatmentRate) / treatmentTrials + controlRate * (1 - controlRate) / controlTrials);
    reviewSampleSizes = [treatmentTrials, controlTrials];
  } else if (input.method === "confidence-interval") {
    estimate = finite(input.estimate, "estimate");
    standardError = positive(input.standardError, "standardError");
    Object.assign(inputs, { estimate, standardError });
  } else {
    const treatmentValues = values(input.treatmentValues, "treatmentValues");
    const controlValues = values(input.controlValues, "controlValues");
    const combined = treatmentValues.map((value) => ({ value, group: 1 })).concat(controlValues.map((value) => ({ value, group: 0 }))).sort((a, b) => a.value - b.value);
    let rank = 1; let rankSumTreatment = 0; let tieCorrection = 0;
    for (let index = 0; index < combined.length;) {
      let end = index + 1;
      while (end < combined.length && combined[end].value === combined[index].value) end += 1;
      const averageRank = (rank + rank + (end - index) - 1) / 2;
      for (let cursor = index; cursor < end; cursor += 1) if (combined[cursor].group === 1) rankSumTreatment += averageRank;
      const tieSize = end - index; if (tieSize > 1) tieCorrection += tieSize ** 3 - tieSize;
      rank += end - index; index = end;
    }
    const treatmentSize = treatmentValues.length; const controlSize = controlValues.length; const total = treatmentSize + controlSize;
    const uTreatment = rankSumTreatment - treatmentSize * (treatmentSize + 1) / 2;
    const probability = uTreatment / (treatmentSize * controlSize);
    estimate = probability - 0.5;
    const variance = treatmentSize * controlSize / 12 * (total + 1 - tieCorrection / (total * (total - 1)));
    standardError = variance > 0 ? Math.sqrt(variance) : undefined;
    const continuity = estimate >= 0 ? 0.5 : -0.5;
    const z = standardError ? (uTreatment - treatmentSize * controlSize / 2 - continuity) / standardError : undefined;
    Object.assign(inputs, { treatmentSampleSize: treatmentSize, controlSampleSize: controlSize, uTreatment, probability });
    reviewSampleSizes = [treatmentSize, controlSize];
    const review = reviewMetadata("mann-whitney-u", reviewSampleSizes);
    const pValue = z === undefined ? undefined : 2 * (1 - normalCdf(Math.abs(z)));
    return { schema: "dsh-sci.statistical-result.v1", method: input.method, version: "dsh-sci.stats.v1", estimate, standardError, ...(pValue === undefined ? {} : { pValue }), effectSize: probability, confidenceLevel, alpha, direction, conclusion: conclusionFor(estimate, pValue, direction, alpha), inputs, ...review };
  }
  if (input.method === "cohens-d") {
    const treatmentSampleSize = inputs.treatmentSampleSize;
    const controlSampleSize = inputs.controlSampleSize;
    const d = effectSize ?? estimate;
    const effectStandardError = Math.sqrt((treatmentSampleSize + controlSampleSize) / (treatmentSampleSize * controlSampleSize) + (d ** 2) / (2 * (treatmentSampleSize + controlSampleSize - 2)));
    const pValue = effectStandardError > 0 ? 2 * (1 - normalCdf(Math.abs(d / effectStandardError))) : undefined;
    const margin = normalQuantile((1 + confidenceLevel) / 2) * effectStandardError;
    const review = reviewMetadata(input.method, reviewSampleSizes);
    return { schema: "dsh-sci.statistical-result.v1", method: input.method, version: "dsh-sci.stats.v1", estimate: d, standardError: effectStandardError, effectSize: d, confidenceLevel, alpha, direction, pValue, lowerBound: d - margin, upperBound: d + margin, conclusion: conclusionFor(d, pValue, direction, alpha), inputs, ...review };
  }
  const z = standardError && standardError > 0 ? estimate / standardError : undefined;
  const pValue = input.method === "welch-t" ? (z === undefined || degreesOfFreedom === undefined ? undefined : 2 * (1 - studentTCdf(Math.abs(z), degreesOfFreedom))) : z === undefined ? undefined : 2 * (1 - normalCdf(Math.abs(z)));
  const margin = standardError === undefined ? undefined : normalQuantile((1 + confidenceLevel) / 2) * standardError;
  const review = reviewMetadata(input.method, reviewSampleSizes);
  return { schema: "dsh-sci.statistical-result.v1", method: input.method, version: "dsh-sci.stats.v1", estimate, standardError, ...(margin === undefined ? {} : { lowerBound: estimate - margin, upperBound: estimate + margin }), ...(pValue === undefined ? {} : { pValue }), confidenceLevel, alpha, direction, conclusion: conclusionFor(estimate, pValue, direction, alpha), inputs, ...(degreesOfFreedom === undefined ? {} : { degreesOfFreedom }), ...review };
}

/** Deterministic evaluator used before asking a model to explain results. */
export function evaluateResearchMetrics(metrics: Array<EvaluationMetric & { criterion?: EvaluationCriterion; tolerance?: number }>): EvaluationConclusion {
  if (!metrics.length) return "inconclusive";
  let supports = true;
  let refutes = false;
  for (const metric of metrics) {
    if (metric.statistical) {
      const result = evaluateStatisticalMetric(metric.statistical);
      supports &&= result.conclusion === "supports";
      refutes ||= result.conclusion === "refutes";
      continue;
    }
    if (metric.pairedBootstrap) {
      const result = evaluatePairedBootstrap(bootstrapInputForMetric(metric));
      supports &&= result.conclusion === "supports";
      refutes ||= result.conclusion === "refutes";
      continue;
    }
    const tolerance = metric.tolerance ?? metric.uncertainty ?? 0;
    const criterion = metric.criterion ?? "at-least";
    if (metric.observed === undefined) { supports = false; continue; }
    if (criterion === "in-range") {
      if (metric.lowerBound === undefined || metric.upperBound === undefined) { supports = false; continue; }
      const pass = metric.observed >= metric.lowerBound - tolerance && metric.observed <= metric.upperBound + tolerance;
      supports &&= pass;
      refutes ||= !pass;
      continue;
    }
    if (metric.expected === undefined) { supports = false; continue; }
    const pass = criterion === "at-most" ? metric.observed <= metric.expected + tolerance : criterion === "close" ? Math.abs(metric.observed - metric.expected) <= tolerance : metric.observed >= metric.expected - tolerance;
    supports &&= pass;
    refutes ||= !pass;
  }
  return supports ? "supports" : refutes ? "refutes" : "inconclusive";
}

function text(value: unknown, field: string, max = 4_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${field} is too long`);
  return result;
}

function idList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return [...new Set(value.map((item, index) => text(item, `${field}[${index}]`, 256)))];
}

function numberValue(value: unknown, field: string, required = true): number | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
  return value;
}

export function makeResearchEvaluation(projectId: string, input: {
  planId?: string;
  taskId?: string;
  experimentRunIds?: string[];
  artifactIds?: string[];
  metrics: EvaluationMetric[];
  conclusion: EvaluationConclusion;
  summary: string;
  limitations?: string[];
  nextAction?: string;
}, now = new Date().toISOString(), evaluationId = randomUUID()): ResearchEvaluation {
  if (!Array.isArray(input.metrics) || input.metrics.length > 100) throw new Error("evaluation.metrics must contain at most 100 items");
  const metrics = input.metrics.map((metric, index) => {
    if (!metric || typeof metric !== "object") throw new Error(`evaluation.metrics[${index}] must be an object`);
    const value = metric as EvaluationMetric;
    const statistical = value.statistical === undefined ? undefined : evaluateStatisticalMetric(value.statistical);
    const pairedBootstrap = value.pairedBootstrap === undefined ? undefined : evaluatePairedBootstrap(bootstrapInputForMetric(value));
    const observed = statistical?.estimate ?? pairedBootstrap?.estimate ?? numberValue(value.observed, `evaluation.metrics[${index}].observed`)!;
    const expected = numberValue(value.expected, `evaluation.metrics[${index}].expected`, false);
    const uncertainty = numberValue(value.uncertainty, `evaluation.metrics[${index}].uncertainty`, false);
    const sampleSize = numberValue(value.sampleSize, `evaluation.metrics[${index}].sampleSize`, false);
    if (sampleSize !== undefined && (!Number.isSafeInteger(sampleSize) || sampleSize < 1)) throw new Error(`evaluation.metrics[${index}].sampleSize must be a positive integer`);
    if (uncertainty !== undefined && uncertainty < 0) throw new Error(`evaluation.metrics[${index}].uncertainty must be non-negative`);
    const criterion = value.criterion === undefined ? undefined : (["at-least", "at-most", "close", "in-range"].includes(value.criterion) ? value.criterion : (() => { throw new Error(`evaluation.metrics[${index}].criterion is invalid`); })());
    const tolerance = value.tolerance === undefined ? undefined : numberValue(value.tolerance, `evaluation.metrics[${index}].tolerance`, false);
    if (tolerance !== undefined && tolerance < 0) throw new Error(`evaluation.metrics[${index}].tolerance must be non-negative`);
    const lowerBound = numberValue(value.lowerBound, `evaluation.metrics[${index}].lowerBound`, false);
    const upperBound = numberValue(value.upperBound, `evaluation.metrics[${index}].upperBound`, false);
    if (criterion === "in-range" && (lowerBound === undefined || upperBound === undefined || lowerBound > upperBound)) throw new Error(`evaluation.metrics[${index}] in-range requires ordered lowerBound and upperBound`);
    return { name: text(value.name, `evaluation.metrics[${index}].name`, 256), observed, ...(expected === undefined ? {} : { expected }), ...(uncertainty === undefined ? {} : { uncertainty }), ...(value.unit === undefined ? {} : { unit: text(value.unit, `evaluation.metrics[${index}].unit`, 128) }), ...(sampleSize === undefined ? {} : { sampleSize }), ...(criterion === undefined ? {} : { criterion }), ...(tolerance === undefined ? {} : { tolerance }), ...(lowerBound === undefined ? {} : { lowerBound }), ...(upperBound === undefined ? {} : { upperBound }), ...(statistical ? { statistical: value.statistical, computed: statistical } : {}), ...(pairedBootstrap ? { pairedBootstrap: { ...value.pairedBootstrap!, version: pairedBootstrap.version }, computedBootstrap: pairedBootstrap } : {}) };
  });
  if (!["supports", "refutes", "inconclusive"].includes(input.conclusion)) throw new Error("evaluation.conclusion is invalid");
  if (input.limitations !== undefined && !Array.isArray(input.limitations)) throw new Error("evaluation.limitations must be an array");
  const limitations = (input.limitations ?? []).map((item, index) => text(item, `evaluation.limitations[${index}]`, 2_000));
  if (limitations.length > 100) throw new Error("evaluation.limitations contains too many items");
  return { schema: "dsh-sci.research-evaluation.v1", evaluationId: text(evaluationId, "evaluationId", 256), projectId: text(projectId, "projectId", 256), planId: input.planId ? text(input.planId, "evaluation.planId", 256) : undefined, taskId: input.taskId ? text(input.taskId, "evaluation.taskId", 256) : undefined, experimentRunIds: idList(input.experimentRunIds, "evaluation.experimentRunIds"), artifactIds: idList(input.artifactIds, "evaluation.artifactIds"), metrics, conclusion: input.conclusion, summary: text(input.summary, "evaluation.summary"), limitations, nextAction: input.nextAction ? text(input.nextAction, "evaluation.nextAction") : undefined, createdAt: now };
}
