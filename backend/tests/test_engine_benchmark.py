"""The engine's generalisation, pinned.

The golden scenario proves one known answer; this pins what the engine does on
held-out generated estates, so a change that quietly makes grouping or root
cause worse fails CI instead of shipping. Floors sit a little under today's
measured values (the sweep is deterministic, so they are not flaky).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.engine.benchmark import CONFIGS, HELD_OUT_SEEDS, benchmark  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="module")
def bench():
    return benchmark()


def test_measures_held_out_seeds_across_every_config(bench):
    assert bench["held_out"] is True
    assert bench["seeds"] == list(HELD_OUT_SEEDS)
    assert [r["key"] for r in bench["configs"]] == [c.key for c in CONFIGS]
    assert bench["overall"]["runs"] == len(CONFIGS) * len(HELD_OUT_SEEDS)


def test_root_cause_stays_accurate_everywhere(bench):
    for row in bench["configs"]:
        assert row["root_cause_accuracy"] >= 0.9, row["label"]


def test_grouping_quality_does_not_regress(bench):
    by_key = {r["key"]: r for r in bench["configs"]}
    assert by_key["staggered_3"]["pair_f1"] >= 0.78
    assert by_key["staggered_6"]["pair_f1"] >= 0.68
    assert by_key["concurrent_3"]["pair_f1"] >= 0.55
    assert by_key["concurrent_6"]["pair_f1"] >= 0.48


def test_concurrent_incidents_are_reported_as_the_harder_case(bench):
    """The known weak spot must stay visible, not averaged away."""
    by_key = {r["key"]: r for r in bench["configs"]}
    assert by_key["concurrent_3"]["concurrent"] is True
    assert by_key["concurrent_3"]["pair_precision"] < by_key["staggered_3"]["pair_precision"]


def test_endpoint_serves_the_same_measurement(bench):
    body = TestClient(app).get("/engine/benchmark").json()
    assert body["overall"] == bench["overall"]
