import test from "node:test";
import assert from "node:assert/strict";
import { replayLoss, verifyReplay, type ReplaySummary, type ReplayConfig } from "../src/research/replay.js";

// Generated independently with test/fixtures/replay-reference.py. Expected
// intervals are constants; this test never imports the experiment/evaluator.
function fixture() {
  const config: ReplayConfig = { master: 7, B: 10000, n: 4, repetitions: 100, distributions: ["normal"], rates: [.25], maskRule: "fixed-count-fisher-yates", relativeDenominator: "mean" };
  const data = Array.from({ length: 100 }, (_, i) => ({ distribution: "normal", replicate: i + 1, x: [1, 2, 9, 101 + i], masks: { "0.25": [3] } }));
  const rows = data.map((item) => {
    const r = item.replicate;
    return { distribution: "normal", replicate: r, p: .25, valid: true, nObserved: 3, nMissing: 1, MSE: { mean: (96 + r) ** 2, median: (98 + r) ** 2, difference: -388 - 4 * r }, MAE: { mean: 96 + r, median: 98 + r, difference: -2 } };
  });
  const summaries: ReplaySummary[] = [
    { distribution: "normal", p: .25, metric: "MSE", requestedReplicates: 100, replicates: 100, meanLoss: 22295.5, medianLoss: 22885.5, delta: -590, relative: -0.02646273911775919, ci: [-613.04, -567.119], relativeCI: [-0.02751489530492936, -0.025532028975529152], seed: 2398417367, resamples: 10000, status: "analyzed" },
    { distribution: "normal", p: .25, metric: "MSE", requestedReplicates: 8, replicates: 8, meanLoss: 10105.5, medianLoss: 10511.5, delta: -406, relative: -0.040176141705012124, ci: [-412.5, -399.5], relativeCI: [-0.04084397244693223, -0.039544163640939], seed: 1016559893, resamples: 10000, status: "inconclusive/review" },
    { distribution: "normal", p: .25, metric: "MAE", requestedReplicates: 100, replicates: 100, meanLoss: 146.5, medianLoss: 148.5, delta: -2, relative: -0.013651877133105802, ci: [-2, -2], relativeCI: [-0.014212646058895096, -0.013145786775338505], seed: 1926378369, resamples: 10000, status: "analyzed" },
    { distribution: "normal", p: .25, metric: "MAE", requestedReplicates: 8, replicates: 8, meanLoss: 100.5, medianLoss: 102.5, delta: -2, relative: -0.01990049751243781, ci: [-2, -2], relativeCI: [-0.020202020202020204, -0.019583843329253364], seed: 1220156987, resamples: 10000, status: "inconclusive/review" },
  ];
  return { config, data, rows, summaries };
}

test("independent replay matches Python reference for paired 8/100-replicate intervals", () => {
  const input = fixture();
  const result = verifyReplay(input);
  assert.equal(result.status, "matched", result.mismatches.join("\n"));
  assert.equal(result.rowsChecked, 100);
  assert.equal(result.summariesChecked, 4);
  assert.ok(Object.values(result.checks).every(Boolean));
  // Input file ordering is irrelevant; replicate identity defines bootstrap order.
  input.data.reverse(); input.rows.reverse(); input.summaries.reverse();
  assert.equal(verifyReplay(input).status, "matched");
});

test("independent replay cannot pass incomplete, duplicate or foreign condition matrices", () => {
  const mutations = [
    (input: ReturnType<typeof fixture>) => { input.data.splice(2, 1); },
    (input: ReturnType<typeof fixture>) => { input.rows.splice(2, 1); },
    (input: ReturnType<typeof fixture>) => { input.summaries.splice(0, 1); },
    (input: ReturnType<typeof fixture>) => { input.rows.push(input.rows[0]); },
    (input: ReturnType<typeof fixture>) => { input.data.push(input.data[0]); },
    (input: ReturnType<typeof fixture>) => { input.summaries.push(input.summaries[0]); },
    (input: ReturnType<typeof fixture>) => { input.rows.push({ ...input.rows[0], replicate: 0 }); },
    (input: ReturnType<typeof fixture>) => { input.summaries[0].metric = "other" as "MSE"; },
  ];
  for (const mutate of mutations) {
    const input = fixture(); mutate(input);
    const result = verifyReplay(input);
    assert.equal(result.status, "review");
    assert.equal(result.checks.coverage, false);
  }
});

test("replay checks denominator, bootstrap settings and every eight-repeat control", () => {
  const input = fixture();
  input.summaries[0].relative = input.summaries[0].delta / input.summaries[0].medianLoss;
  input.summaries[0].resamples = 100;
  input.summaries[1].status = "analyzed";
  input.summaries[1].conclusion = "inconclusive";
  input.summaries[2].relativeCI![0] += .01;
  const result = verifyReplay(input);
  assert.equal(result.status, "review");
  assert.equal(result.checks.summaryValues, false);
  assert.equal(result.checks.bootstrapIntervals, false);
  assert.equal(result.checks.control8Inconclusive, false);
  const legacy = fixture();
  assert.throws(() => verifyReplay({ ...legacy, config: { ...legacy.config, relativeDenominator: "median" as "mean" } }), /mean-loss denominator/);
});

test("raw masks require unique in-range indices, fixed counts and complete raw samples", () => {
  const input = fixture();
  input.data[0].masks["0.25"] = [3, 3];
  input.data[1].x.pop();
  const result = verifyReplay(input);
  assert.equal(result.status, "review");
  assert.equal(result.checks.replicateRows, false);
  assert.match(result.mismatches.join("\n"), /mask indices are invalid/);
  assert.match(result.mismatches.join("\n"), /sample size mismatch/);
  assert.throws(() => replayLoss({ distribution: "normal", replicate: 1, x: [1, 2, 3, 4], masks: { "0.25": [] } }, .25), /mask size/);
});

test("zero baselines remain explicitly undefined and nonfinite losses cannot match", () => {
  const input = fixture();
  for (const item of input.data) item.x = [0, 0, 0, 0];
  for (const row of input.rows) { row.MSE = { mean: 0, median: 0, difference: 0 }; row.MAE = { mean: 0, median: 0, difference: 0 }; }
  for (const summary of input.summaries) { Object.assign(summary, { meanLoss: 0, medianLoss: 0, delta: 0, relative: null, ci: [0, 0], relativeCI: null }); }
  assert.equal(verifyReplay(input).status, "matched");
  input.summaries[0].relativeCI = [0, 0];
  assert.equal(verifyReplay(input).checks.bootstrapIntervals, false);
  assert.throws(() => replayLoss({ distribution: "normal", replicate: 1, x: [1e308, 1e308, 1e308, -1e308], masks: { "0.25": [3] } }, .25), /must be finite/);
});

test("independent replay recomputes paired losses and rejects incomplete summaries", () => {
  const data = Array.from({ length: 8 }, (_, replicate) => ({ distribution: "normal", replicate: replicate + 1, x: [1, 2, 4, 8], masks: { "0.3": [0] } }));
  const rows = data.map((item) => replayLoss(item, 0.3));
  const result = verifyReplay({ config: { master: 7, B: 100, rates: [0.3], n: 4, repetitions: 8, distributions: ["normal"], maskRule: "fixed-count-fisher-yates", relativeDenominator: "mean" }, data, rows, summaries: [] });
  assert.equal(rows[0].valid, true);
  assert.equal(rows[0].nMissing, 1);
  assert.equal(result.status, "review");
  assert.equal(result.checks.control8Inconclusive, false);
  assert.match(result.mismatches.join("\n"), /8-repeat control/);
});

test("independent replay catches a changed replicate value", () => {
  const data = [{ distribution: "normal", replicate: 1, x: [1, 2, 4, 8], masks: { "0.3": [0] } }];
  const row = replayLoss(data[0], 0.3);
  const changed = { ...row, MSE: { ...row.MSE!, difference: row.MSE!.difference + 1 } };
  const result = verifyReplay({ config: { master: 7, B: 100, rates: [0.3], n: 4, repetitions: 8, distributions: ["normal"], maskRule: "fixed-count-fisher-yates", relativeDenominator: "mean" }, data, rows: [changed], summaries: [] });
  assert.equal(result.status, "review");
  assert.match(result.mismatches.join("\n"), /value mismatch/);
});
