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

from . import scenarios
from .correlate import DependencyGraph
from .pipeline import evaluate, run
from .review import ReviewQueue

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


def _score(config: Config, seeds: tuple[int, ...]) -> dict:
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
