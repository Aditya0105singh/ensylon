"""The benchmark suite runs in a background process on a live backend and must
never block a request while it does."""

from concurrent.futures import Future

import pytest
from fastapi import HTTPException

from app import engine_api


def test_routes_answer_503_with_retry_after_while_the_benchmark_runs(monkeypatch):
    monkeypatch.setattr(engine_api, "_BENCH_FUTURE", Future())          # not done yet
    with pytest.raises(HTTPException) as exc:
        engine_api.engine_benchmark_ablation()
    assert exc.value.status_code == 503
    assert exc.value.headers == {"Retry-After": "5"}


def test_routes_serve_the_background_result_once_ready(monkeypatch):
    done = Future()
    done.set_result({"benchmark": {"b": 1}, "ablation": [{"variant": "x"}], "reliability": [{"bucket": "0.9-1.0"}]})
    monkeypatch.setattr(engine_api, "_BENCH_FUTURE", done)
    assert engine_api.engine_benchmark() == {"b": 1}
    assert engine_api.engine_benchmark_ablation() == [{"variant": "x"}]
    assert engine_api.engine_benchmark_reliability() == [{"bucket": "0.9-1.0"}]


def test_a_failed_background_run_falls_back_to_computing_in_process(monkeypatch):
    failed = Future()
    failed.set_exception(RuntimeError("worker died"))
    monkeypatch.setattr(engine_api, "_BENCH_FUTURE", failed)
    monkeypatch.setattr(engine_api.benchmark_mod, "reliability", lambda: [{"bucket": "fallback"}])
    assert engine_api.engine_benchmark_reliability() == [{"bucket": "fallback"}]


def test_compute_all_bundles_every_benchmark_route(monkeypatch):
    from app.engine import benchmark

    monkeypatch.setattr(benchmark, "benchmark", lambda seeds: {"b": seeds})
    monkeypatch.setattr(benchmark, "ablation", lambda seeds: ["a"])
    monkeypatch.setattr(benchmark, "reliability", lambda seeds: ["r"])
    assert benchmark.compute_all((21,)) == {"benchmark": {"b": (21,)}, "ablation": ["a"], "reliability": ["r"]}
