import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { evaluatePairedBootstrap, evaluateResearchMetrics, makeResearchEvaluation, type PairedBootstrapInput } from "../src/research/evaluation.js";
import { ResearchRepository } from "../src/research/repository.js";

// Golden order statistics were obtained with independent BigInt arithmetic,
// not this implementation: research/validation/bootstrap-seed-oracle-20261030.
const input: PairedBootstrapInput = { differences: [0, 1, 10, 100], resamples: 100, confidenceLevel: 0.5, seed: 0 };

test("bootstrap v2 respects seed zero and preserves explicit v1 numerical replay", () => {
  const current = evaluatePairedBootstrap(input);
  assert.equal(current.version, "dsh-sci.bootstrap.v2");
  assert.deepEqual([current.lowerBound, current.upperBound], [3, 32.5]);
  const legacy = evaluatePairedBootstrap({ ...input, version: "dsh-sci.bootstrap.v1" });
  assert.deepEqual([legacy.lowerBound, legacy.upperBound], [4.5625, 30.25]);
  assert.equal(legacy.version, "dsh-sci.bootstrap.v1");
  const seven = evaluatePairedBootstrap({ ...input, seed: 7 });
  assert.deepEqual([seven.lowerBound, seven.upperBound], [20.6875, 36.875]);
  assert.deepEqual({ ...evaluatePairedBootstrap({ ...input, seed: 7, version: "dsh-sci.bootstrap.v1" }), version: seven.version }, seven);
  assert.equal(current.conclusion, "inconclusive");
});

test("bootstrap version and seed boundaries reject ambiguous new streams while retaining historical coercion", () => {
  for (const seed of [-1, 0.5, NaN, Infinity, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => evaluatePairedBootstrap({ ...input, seed }), /seed/);
  }
  assert.equal(evaluatePairedBootstrap({ ...input, seed: 0xffffffff }).seed, 0xffffffff);
  assert.throws(() => evaluatePairedBootstrap({ ...input, version: "unknown" as any }), /unsupported paired bootstrap version/);
  const coerced = evaluatePairedBootstrap({ ...input, version: "dsh-sci.bootstrap.v1", seed: 2 ** 32 });
  assert.deepEqual([coerced.lowerBound, coerced.upperBound], [4.5625, 30.25]);
});

test("new evaluations pin the algorithm; historical results load unchanged and re-evaluate using their saved version", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-sci-bootstrap-version-"));
  try {
    const repository = new ResearchRepository(root);
    const evaluation = makeResearchEvaluation("version-project", { metrics: [{ name: "difference", pairedBootstrap: input }], summary: "New v2 computation", conclusion: "inconclusive" });
    assert.equal(evaluation.metrics[0].pairedBootstrap?.version, "dsh-sci.bootstrap.v2");
    await repository.saveEvaluation(evaluation);
    assert.equal(JSON.stringify(await repository.readEvaluation("version-project", evaluation.evaluationId)), JSON.stringify(evaluation));
    // Historical storage contained no input version, only a computed version.
    const historical = { ...evaluation, evaluationId: "historical-bootstrap", metrics: [{ name: "difference", pairedBootstrap: input, computedBootstrap: evaluatePairedBootstrap({ ...input, version: "dsh-sci.bootstrap.v1" }) }] };
    const frozen = JSON.stringify(historical);
    await repository.saveEvaluation(historical);
    const loaded = (await repository.readEvaluation("version-project", historical.evaluationId))!;
    assert.equal(JSON.stringify(loaded), frozen);
    const replay = makeResearchEvaluation("version-project", { metrics: loaded.metrics, summary: "Explicitly re-evaluate historical input", conclusion: "inconclusive" });
    assert.equal(replay.metrics[0].pairedBootstrap?.version, "dsh-sci.bootstrap.v1");
    assert.deepEqual([replay.metrics[0].computedBootstrap!.lowerBound, replay.metrics[0].computedBootstrap!.upperBound], [4.5625, 30.25]);
    assert.equal(evaluateResearchMetrics(loaded.metrics), "inconclusive");
    const contradictory = [{ ...loaded.metrics[0], pairedBootstrap: { ...input, version: "dsh-sci.bootstrap.v2" as const } }];
    assert.throws(() => evaluateResearchMetrics(contradictory), /versions disagree/);
    assert.throws(() => makeResearchEvaluation("version-project", { metrics: contradictory, summary: "Reject disagreement", conclusion: "inconclusive" }), /versions disagree/);
    assert.equal(JSON.stringify(await repository.readEvaluation("version-project", historical.evaluationId)), frozen);
  } finally { await rm(root, { recursive: true, force: true }); }
});
