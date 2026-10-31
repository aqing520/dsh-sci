import { createHash } from "node:crypto";

export interface ReplayDataFile { distribution: string; replicate: number; x: number[]; u?: number[]; masks?: Record<string, number[]>; }
export interface ReplayConfig { master: number; B: number; rates: number[]; n: number; repetitions: number; distributions: string[]; maskRule: "fixed-count-fisher-yates"; relativeDenominator: "mean"; }
export interface ReplayRow { distribution: string; replicate: number; p: number; valid: boolean; nObserved: number; nMissing: number; MSE?: { mean: number; median: number; difference: number }; MAE?: { mean: number; median: number; difference: number }; }
export interface ReplaySummary { distribution: string; p: number; metric: "MSE" | "MAE"; requestedReplicates: number; replicates: number; meanLoss: number; medianLoss: number; delta: number; relative: number | null; ci: [number, number]; relativeCI: [number, number] | null; status?: string; conclusion?: string; resamples?: number; seed?: number; }
export interface ReplayVerification { schema: "dsh-sci.research-replay-verification.v1"; rowsChecked: number; summariesChecked: number; mismatches: string[]; checks: { coverage: boolean; maskRule: boolean; replicateRows: boolean; summaryValues: boolean; bootstrapIntervals: boolean; control8Inconclusive: boolean }; status: "matched" | "review"; independentPath: string; }

const finite = (value: unknown, field: string): number => { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${field} must be finite`); return value; };
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const close = (left: number | null | undefined, right: number | null | undefined, tolerance = 1e-10): boolean => left === right || (typeof left === "number" && typeof right === "number" && Math.abs(left - right) <= tolerance * Math.max(1, Math.abs(left), Math.abs(right)));
const fnv = (value: string): number => { let hash = 2166136261; for (const byte of Buffer.from(value, "utf8")) hash = Math.imul(hash ^ byte, 16777619) >>> 0; return hash >>> 0; };

/** Independent recomputation of one condition. It does not call the experiment
 * implementation or the product evaluator. */
export function replayLoss(data: ReplayDataFile, p: number): ReplayRow {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) throw new Error("replay rate must be between zero and one");
  if (!Array.isArray(data.x) || data.x.length < 2) throw new Error("replay data arrays are invalid");
  const mask = data.masks?.[String(p)];
  let missing: Set<number> | undefined;
  if (mask !== undefined) {
    if (!Array.isArray(mask) || mask.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= data.x.length) || new Set(mask).size !== mask.length) throw new Error("replay mask indices are invalid");
    if (mask.length !== Math.floor(data.x.length * p)) throw new Error("replay fixed-count mask size differs from protocol");
    missing = new Set(mask);
  } else if (!Array.isArray(data.u) || data.x.length !== data.u.length) throw new Error("replay mask is missing");
  const observed: number[] = [], hidden: number[] = [];
  for (let index = 0; index < data.x.length; index += 1) {
    const x = finite(data.x[index], `x[${index}]`);
    const u = missing ? undefined : finite(data.u![index], `u[${index}]`);
    if (u !== undefined && (u < 0 || u >= 1)) throw new Error("replay mask values must be in [0,1)");
    (missing ? missing.has(index) ? hidden : observed : u! < p ? hidden : observed).push(x);
  }
  const base: ReplayRow = { distribution: data.distribution, replicate: data.replicate, p, valid: observed.length > 0 && hidden.length > 0, nObserved: observed.length, nMissing: hidden.length };
  if (!base.valid) return base;
  const sorted = [...observed].sort((a, b) => a - b);
  const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const fitted = { mean: mean(observed), median };
  const mseMean = mean(hidden.map((value) => (value - fitted.mean) ** 2));
  const mseMedian = mean(hidden.map((value) => (value - fitted.median) ** 2));
  const maeMean = mean(hidden.map((value) => Math.abs(value - fitted.mean)));
  const maeMedian = mean(hidden.map((value) => Math.abs(value - fitted.median)));
  for (const [name, value] of Object.entries({ mseMean, mseMedian, maeMean, maeMedian })) finite(value, name);
  return { ...base, MSE: { mean: mseMean, median: mseMedian, difference: mseMean - mseMedian }, MAE: { mean: maeMean, median: maeMedian, difference: maeMean - maeMedian } };
}

function independentRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let value = Math.imul(state ^ (state >>> 15), state | 1); value ^= value + Math.imul(value ^ (value >>> 7), value | 61); return ((value ^ (value >>> 14)) >>> 0) / 4294967296; };
}
function percentile(values: number[], q: number): number { const sorted = [...values].sort((a, b) => a - b); const position = (sorted.length - 1) * q; const lower = Math.floor(position); const upper = Math.ceil(position); return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower); }
function bootstrap(rows: Array<{ mean: number; median: number }>, seed: number, resamples: number): { ci: [number, number]; relativeCI: [number, number] | null } {
  const random = independentRng(seed), differences: number[] = [], ratios: number[] = [];
  for (let iteration = 0; iteration < resamples; iteration += 1) { let sumMean = 0, sumMedian = 0; for (let index = 0; index < rows.length; index += 1) { const row = rows[Math.floor(random() * rows.length)]; sumMean += row.mean; sumMedian += row.median; } const difference = (sumMean - sumMedian) / rows.length; differences.push(difference); if (sumMean !== 0) ratios.push((sumMean - sumMedian) / sumMean); }
  return { ci: [percentile(differences, .025), percentile(differences, .975)], relativeCI: ratios.length === resamples ? [percentile(ratios, .025), percentile(ratios, .975)] : null };
}

export function verifyReplay(input: { config: ReplayConfig; data: ReplayDataFile[]; rows: ReplayRow[]; summaries: ReplaySummary[] }): ReplayVerification {
  const { config } = input;
  if (!Number.isSafeInteger(config.master) || config.master < 0 || config.master > 0xffffffff || !Number.isSafeInteger(config.B) || config.B < 100 || config.B > 100_000 || !Number.isSafeInteger(config.n) || config.n < 2 || !Number.isSafeInteger(config.repetitions) || config.repetitions < 8 || !Array.isArray(config.rates) || !config.rates.length || config.rates.some((p) => !Number.isFinite(p) || p <= 0 || p >= 1) || new Set(config.rates).size !== config.rates.length || !Array.isArray(config.distributions) || !config.distributions.length || config.distributions.some((name) => typeof name !== "string" || !name) || new Set(config.distributions).size !== config.distributions.length || config.maskRule !== "fixed-count-fisher-yates" || config.relativeDenominator !== "mean") throw new Error("Replay config must specify the fixed-count protocol, complete condition matrix and mean-loss denominator");
  const mismatches: string[] = [];
  const checks = { coverage: true, maskRule: true, replicateRows: true, summaryValues: true, bootstrapIntervals: true, control8Inconclusive: true };
  const fail = (check: keyof typeof checks, message: string) => { checks[check] = false; mismatches.push(message); };
  const key = (...items: unknown[]) => JSON.stringify(items);
  const index = <T>(values: T[], getKey: (item: T) => string, label: string) => {
    const result = new Map<string, T>();
    for (const item of values) { const id = getKey(item); if (result.has(id)) fail("coverage", `duplicate ${label} ${id}`); result.set(id, item); }
    return result;
  };
  const dataByKey = index(input.data, (item) => key(item.distribution, item.replicate), "data");
  const rowByKey = index(input.rows, (item) => key(item.distribution, item.replicate, item.p), "row");
  const summaryByKey = index(input.summaries, (item) => key(item.distribution, item.p, item.metric, item.requestedReplicates), "summary");
  const expectedData = new Set<string>(), expectedRows = new Map<string, ReplayRow>(), expectedSummaries = new Set<string>();
  let rowsChecked = 0, summariesChecked = 0;
  for (const distribution of config.distributions) for (let replicate = 1; replicate <= config.repetitions; replicate += 1) {
    const dataKey = key(distribution, replicate), data = dataByKey.get(dataKey);
    expectedData.add(dataKey);
    if (!data) { fail("coverage", `missing data ${dataKey}`); continue; }
    if (!Array.isArray(data.x) || data.x.length !== config.n) { fail("replicateRows", `sample size mismatch ${dataKey}`); continue; }
    for (const p of config.rates) {
      const rowKey = key(distribution, replicate, p), actual = rowByKey.get(rowKey);
      if (!data.masks?.[String(p)]) { fail("maskRule", `missing fixed-count mask ${rowKey}; Bernoulli masks cannot replay this protocol`); continue; }
      let expected: ReplayRow;
      try { expected = replayLoss(data, p); } catch (error) { fail("replicateRows", `invalid raw data ${rowKey}: ${(error as Error).message}`); continue; }
      expectedRows.set(rowKey, expected);
      rowsChecked += 1;
      if (!actual) { fail("coverage", `missing row ${rowKey}`); continue; }
      if (!expected.valid || expected.valid !== actual.valid || expected.nObserved !== actual.nObserved || expected.nMissing !== actual.nMissing) fail("replicateRows", `count/validity mismatch ${rowKey}`);
      for (const metric of ["MSE", "MAE"] as const) for (const field of ["mean", "median", "difference"] as const) if (!close(expected[metric]?.[field], actual[metric]?.[field])) fail("replicateRows", `value mismatch ${metric}.${field} ${rowKey}`);
    }
  }
  for (const distribution of config.distributions) for (const p of config.rates) for (const metric of ["MSE", "MAE"] as const) for (const count of new Set([config.repetitions, 8])) {
    const summaryKey = key(distribution, p, metric, count), summary = summaryByKey.get(summaryKey);
    expectedSummaries.add(summaryKey);
    if (!summary) { fail("coverage", `missing summary ${summaryKey}`); if (count === 8) checks.control8Inconclusive = false; continue; }
    if (count === 8 && summary.status !== "inconclusive/review") fail("control8Inconclusive", `8-repeat control is not marked inconclusive/review ${summaryKey}`);
    const rows = Array.from({ length: count }, (_, i) => expectedRows.get(key(distribution, i + 1, p))).filter((row): row is ReplayRow => Boolean(row?.valid));
    if (rows.length !== count) { fail("summaryValues", `incomplete independent replicate inputs ${summaryKey}`); continue; }
    summariesChecked += 1;
    // Aggregate the independently recomputed losses, never the reported rows.
    const metricRows = rows.map((row) => row[metric]!);
    const meanLoss = mean(metricRows.map((row) => row.mean)), medianLoss = mean(metricRows.map((row) => row.median));
    const delta = mean(metricRows.map((row) => row.difference)), relative = meanLoss === 0 ? null : delta / meanLoss;
    if (summary.replicates !== count || !close(meanLoss, summary.meanLoss) || !close(medianLoss, summary.medianLoss) || !close(delta, summary.delta) || !close(relative, summary.relative)) fail("summaryValues", `summary value mismatch ${summaryKey}`);
    const seedLabel = `${count === 8 ? "bootstrap-control8" : "bootstrap"}/${distribution}/${p.toFixed(2)}/${metric}`, seed = fnv(`${config.master}/${seedLabel}`);
    const expectedBootstrap = bootstrap(metricRows, seed, config.B);
    const intervalMatches = (expected: [number, number] | null, actual: unknown) => expected === null ? actual === null : Array.isArray(actual) && actual.length === 2 && close(expected[0], actual[0]) && close(expected[1], actual[1]);
    if ((summary.resamples !== undefined && summary.resamples !== config.B) || (summary.seed !== undefined && summary.seed !== seed) || !intervalMatches(expectedBootstrap.ci, summary.ci) || !intervalMatches(expectedBootstrap.relativeCI, summary.relativeCI)) fail("bootstrapIntervals", `bootstrap interval/metadata mismatch ${summaryKey}`);
  }
  for (const id of dataByKey.keys()) if (!expectedData.has(id)) fail("coverage", `unexpected data ${id}`);
  const allowedRowKeys = new Set(config.distributions.flatMap((distribution) => Array.from({ length: config.repetitions }, (_, i) => config.rates.map((p) => key(distribution, i + 1, p))).flat()));
  for (const id of rowByKey.keys()) if (!allowedRowKeys.has(id)) fail("coverage", `unexpected row ${id}`);
  for (const id of summaryByKey.keys()) if (!expectedSummaries.has(id)) fail("coverage", `unexpected summary ${id}`);
  if (!checks.control8Inconclusive) mismatches.push("8-repeat control is incomplete or not marked inconclusive/review");
  return { schema: "dsh-sci.research-replay-verification.v1", rowsChecked, summariesChecked, mismatches, checks, status: mismatches.length ? "review" : "matched", independentPath: "raw fixed-count masks + independent loss recomputation + paired mulberry32 bootstrap + percentile interpolation; does not certify source support or simulation generator correctness" };
}

export function replayDigest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
