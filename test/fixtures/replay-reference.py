"""Independent scalar oracle for the replay regression fixture.

Synthetic four-cell arrays only; this never executes the scientific benchmark.
Regenerate the constants in research-replay.test.ts with Python 3, without the
experiment code, product evaluator, or TypeScript replay implementation.
"""
import json


def seed_for(label):
    value = 2166136261
    for byte in ("7/" + label).encode("ascii"):
        value = ((value ^ byte) * 16777619) & 0xffffffff
    return value


def uniform(seed):
    state = seed
    while True:
        state = (state + 0x6d2b79f5) & 0xffffffff
        value = ((state ^ (state >> 15)) * (state | 1)) & 0xffffffff
        value ^= (value + ((value ^ (value >> 7)) * (value | 61))) & 0xffffffff
        yield ((value ^ (value >> 14)) & 0xffffffff) / 2**32


def quantile(values, fraction):
    ordered = sorted(values)
    position = (len(values) - 1) * fraction
    index = int(position)
    return ordered[index] + (ordered[min(index + 1, len(values) - 1)] - ordered[index]) * (position - index)


results = []
for metric in ("MSE", "MAE"):
    for count in (100, 8):
        # Observed [1,2,9], hidden 100+r: fitted mean 4 and median 2.
        power = 2 if metric == "MSE" else 1
        a = [(96 + r) ** power for r in range(1, count + 1)]
        b = [(98 + r) ** power for r in range(1, count + 1)]
        mean_loss, median_loss = sum(a) / count, sum(b) / count
        delta = sum(x - y for x, y in zip(a, b)) / count
        label = ("bootstrap-control8" if count == 8 else "bootstrap") + "/normal/0.25/" + metric
        seed = seed_for(label)
        random = uniform(seed)
        differences, ratios = [], []
        for _ in range(10000):
            indices = [int(next(random) * count) for _ in range(count)]
            sum_a, sum_b = sum(a[i] for i in indices), sum(b[i] for i in indices)
            differences.append((sum_a - sum_b) / count)
            ratios.append((sum_a - sum_b) / sum_a)
        results.append(dict(distribution="normal", p=.25, metric=metric,
                            requestedReplicates=count, replicates=count,
                            meanLoss=mean_loss, medianLoss=median_loss, delta=delta,
                            relative=delta / mean_loss,
                            ci=[quantile(differences, q) for q in (.025, .975)],
                            relativeCI=[quantile(ratios, q) for q in (.025, .975)],
                            seed=seed, resamples=10000,
                            status="inconclusive/review" if count == 8 else "analyzed"))
print(json.dumps(results, indent=2))
