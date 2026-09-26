"""Engine benchmark: the engine scored across many generated estates.

The golden incident is one hand-written scenario, so its perfect scores prove
the engine reproduces a known answer, not that it generalises. This sweeps the
real pipeline (the same `run` the API uses) over generated scenarios that vary
topology, telemetry, incident count, noise and timing, and scores each against
the generator's answer key, which the pipeline never reads.

Seeds 21-40 are held out: the engine's tunable thresholds were chosen on seeds
1-20, so these numbers are measured on estates the tuning never saw.

Concurrent incidents (stagger 0) are reported separately because they are the
hard case and the known weak spot: two failures that share a service or a
dependency edge at the same moment pass the shared-context gate together, and
only the causal split can pull them apart again.
"""

from __future__ import annotations

import statistics
import time
from dataclasses import dataclass
from functools import lru_cache
from itertools import combinations

from scipy.sparse import csr_matrix
from sklearn.cluster import DBSCAN

from . import scenarios
from .correlate import DependencyGraph, EPS, MIN_SAMPLES, default_weights, time_proximity
from .dedup import deduplicate
from .detect import detect
from .pipeline import evaluate, run
from .redaction import redact_all
from .review import ReviewQueue

_DIMENSION_LABELS = {
    "time": "temporal proximity (T)",
    "service": "service affinity (S)",
    "dependency": "dependency closeness (D)",
    "template": "evidence similarity (E)",
    "component": "component match (C)",
}

HELD_OUT_SEEDS = tuple(range(21, 41))


@dataclass(frozen=True)
class Config:
    key: str
    label: str
    n_incidents: int
    noise_signals: int
    stagger_minutes: float


CONFIGS = (
    Config("staggered_3", "3 incidents, staggered", 3, 40, 45.0),
    Config("concurrent_3", "3 incidents, concurrent", 3, 40, 0.0),
    Config("staggered_6", "6 incidents, staggered", 6, 120, 45.0),
    Config("concurrent_6", "6 incidents, concurrent", 6, 120, 0.0),
)


def _score(
    config: Config, seeds: tuple[int, ...], weights: dict[str, float] | None = None,
    points: list[tuple[float, float]] | None = None,
) -> dict:
    """`weights` overrides the dimension weights for this sweep only (the
    ablation benchmark's own runs, never the live engine's). `points`, if
    given, is appended with one (predicted_confidence, actual_purity) pair per
    incident formed, for the reliability curve."""
    precision, recall, f1, purity, noise_precision, runtime = [], [], [], [], [], []
    rc_correct = rc_total = exact = signals = 0
    for seed in seeds:
        sc = scenarios.generate(
            n_incidents=config.n_incidents,
            noise_signals=config.noise_signals,
            seed=seed,
            stagger_minutes=config.stagger_minutes,
        )
        sigs = scenarios.build_signals(sc)
        signals += len(sigs)
        started = time.perf_counter()
        result = run(
            sigs,
            DependencyGraph(scenarios.dependency_edges(sc)),
            queue=ReviewQueue(),
            use_llm=False,
            criticality=scenarios.criticality_map(sc),
            weights=weights,
        )
        runtime.append((time.perf_counter() - started) * 1000)
        ev = evaluate(result, sc.incident_count)
        precision.append(ev.pair_precision)
        recall.append(ev.pair_recall)
        f1.append(ev.pair_f1)
        purity.append(ev.cluster_purity)
        noise_precision.append(ev.noise_precision)
        rc_correct += ev.root_cause_correct
        rc_total += ev.root_cause_total
        exact += int(ev.incidents_formed == ev.incidents_expected)
        if points is not None:
            for incident in result.incidents:
                labels = [s.truth_incident or "NOISE" for s in incident.cluster.signals]
                if not labels:
                    continue
                dominant = max(set(labels), key=labels.count)
                points.append((incident.cluster.confidence, labels.count(dominant) / len(labels)))

    mean = lambda xs: round(statistics.mean(xs), 3) if xs else 0.0
    return {
        "key": config.key,
        "label": config.label,
        "concurrent": config.stagger_minutes == 0,
        "runs": len(seeds),
        "avg_signals": round(signals / len(seeds)) if seeds else 0,
        "pair_precision": mean(precision),
        "pair_recall": mean(recall),
        "pair_f1": mean(f1),
        "worst_pair_f1": round(min(f1), 3) if f1 else 0.0,
        "cluster_purity": mean(purity),
        "noise_precision": mean(noise_precision),
        "root_cause_correct": rc_correct,
        "root_cause_total": rc_total,
        "root_cause_accuracy": round(rc_correct / rc_total, 3) if rc_total else 0.0,
        "exact_incident_count_runs": exact,
        "median_runtime_ms": round(statistics.median(runtime), 1) if runtime else 0.0,
    }


@lru_cache(maxsize=1)
def benchmark(seeds: tuple[int, ...] = HELD_OUT_SEEDS) -> dict:
    """Deterministic, so computed once per process and cached."""
    rows = [_score(c, seeds) for c in CONFIGS]
    rc_correct = sum(r["root_cause_correct"] for r in rows)
    rc_total = sum(r["root_cause_total"] for r in rows)
    return {
        "seeds": list(seeds),
        "held_out": seeds == HELD_OUT_SEEDS,
        "configs": rows,
        "overall": {
            "runs": sum(r["runs"] for r in rows),
            "pair_f1": round(statistics.mean(r["pair_f1"] for r in rows), 3),
            "pair_precision": round(statistics.mean(r["pair_precision"] for r in rows), 3),
            "pair_recall": round(statistics.mean(r["pair_recall"] for r in rows), 3),
            "root_cause_accuracy": round(rc_correct / rc_total, 3) if rc_total else 0.0,
        },
    }


def _time_only_no_gate(seeds: tuple[int, ...]) -> dict:
    """Cluster on time proximity alone, the shared-context gate removed
    entirely - the one thing the brief's core principle warns against
    ("time proximity alone does not prove correlation"). Built standalone
    rather than by threading a gate-bypass flag through correlate.py, so the
    gate the live engine depends on every tick is never touched by this."""
    f1s: list[float] = []
    for seed in seeds:
        for config in CONFIGS:
            sc = scenarios.generate(
                n_incidents=config.n_incidents, noise_signals=config.noise_signals,
                seed=seed, stagger_minutes=config.stagger_minutes,
            )
            sigs, _counts = redact_all(scenarios.build_signals(sc))
            sigs, _dedup = deduplicate(sigs)
            sigs, _detection, _state = detect(sigs, None)
            anomalous = [s for s in sigs if s.is_anomaly]
            n = len(anomalous)
            if n < 2:
                continue

            rows: list[int] = []
            cols: list[int] = []
            data: list[float] = []
            for i, j in combinations(range(n), 2):
                t = time_proximity(anomalous[i], anomalous[j])
                if t == 0.0:
                    continue
                distance = 1.0 - t
                if distance > EPS:
                    continue
                rows.extend([i, j])
                cols.extend([j, i])
                data.extend([max(distance, 1e-6)] * 2)

            matrix = csr_matrix((data, (rows, cols)), shape=(n, n))
            labels = (
                DBSCAN(eps=EPS, min_samples=MIN_SAMPLES, metric="precomputed").fit_predict(matrix)
                if matrix.nnz else [-1] * n
            )

            truth: dict[str, list[str]] = {}
            for s in anomalous:
                if s.truth_incident:
                    truth.setdefault(s.truth_incident, []).append(s.id)
            true_pairs: set[tuple[str, str]] = set()
            for members in truth.values():
                true_pairs.update((a, b) if a < b else (b, a) for a, b in combinations(sorted(members), 2))

            clustered: dict[int, list[str]] = {}
            for idx, label in enumerate(labels):
                if label == -1:
                    continue
                clustered.setdefault(int(label), []).append(anomalous[idx].id)
            predicted_pairs: set[tuple[str, str]] = set()
            for members in clustered.values():
                predicted_pairs.update((a, b) if a < b else (b, a) for a, b in combinations(sorted(members), 2))

            correct = true_pairs & predicted_pairs
            p = len(correct) / len(predicted_pairs) if predicted_pairs else 0.0
            r = len(correct) / len(true_pairs) if true_pairs else 0.0
            f1s.append(2 * p * r / (p + r) if (p + r) else 0.0)

    return {
        "variant": "time proximity only, structural gate removed",
        "pair_f1": round(statistics.mean(f1s), 3) if f1s else 0.0,
        "delta": None,
        "note": "isolates the brief's core principle: time alone, with no shared-context gate",
    }


@lru_cache(maxsize=1)
def ablation(seeds: tuple[int, ...] = HELD_OUT_SEEDS) -> list[dict]:
    """Zero one similarity dimension's weight at a time and re-measure pair
    F1 on the same held-out estates `benchmark()` uses, to show how
    load-bearing each dimension actually is.

    Weights are passed explicitly into this sweep's own runs (see
    correlate.similarity / pipeline.run) - the live engine keeps reading its
    own module-level weights throughout, unaffected by this running
    concurrently."""
    base = benchmark(seeds)["overall"]["pair_f1"]
    rows = [{"variant": "baseline (all five dimensions)", "pair_f1": base, "delta": 0.0}]
    for dim, label in _DIMENSION_LABELS.items():
        w = default_weights()
        w[dim] = 0.0
        f1 = round(statistics.mean(_score(c, seeds, weights=w)["pair_f1"] for c in CONFIGS), 3)
        rows.append({"variant": f"without {label}", "pair_f1": f1, "delta": round(f1 - base, 3)})
    rows.append(_time_only_no_gate(seeds))
    return rows


@lru_cache(maxsize=1)
def reliability(seeds: tuple[int, ...] = HELD_OUT_SEEDS) -> list[dict]:
    """Calibration curve: bucket every incident the benchmark formed by its
    own predicted correlation confidence, and compare against how pure that
    incident actually was against the generator's answer key. A bucket that
    sits well above the diagonal is confidence that overstates how much to
    trust the incident; well below, confidence that understates it."""
    points: list[tuple[float, float]] = []
    for config in CONFIGS:
        _score(config, seeds, points=points)

    buckets: dict[int, list[tuple[float, float]]] = {}
    for predicted, actual in points:
        idx = min(9, int(predicted * 10))
        buckets.setdefault(idx, []).append((predicted, actual))

    return [
        {
            "bucket": f"{idx / 10:.1f}-{(idx + 1) / 10:.1f}",
            "predicted": round(statistics.mean(v[0] for v in buckets[idx]), 3),
            "actual": round(statistics.mean(v[1] for v in buckets[idx]), 3),
            "n": len(buckets[idx]),
        }
        for idx in sorted(buckets)
    ]


def compute_all(seeds: tuple[int, ...] = HELD_OUT_SEEDS) -> dict:
    """Everything the /engine/benchmark* routes serve, in one call.

    A live backend runs this in a separate process at startup (see
    engine_api.warm_benchmarks): it is ~30 s of pure-Python CPU, and inside the
    server process it would hold the GIL against live ingestion and every
    other request - long enough for the UI to report the backend offline."""
    return {"benchmark": benchmark(seeds), "ablation": ablation(seeds), "reliability": reliability(seeds)}
