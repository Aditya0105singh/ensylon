"""A cause cannot fail long after the services it is said to have broken.

Found on real simulator data: carrier-service (which calls comms-service) began
failing at 10:10; comms-service only began failing at 10:28 in the same
candidate incident. The graph says a failing callee makes its caller a symptom,
so comms-service was ranked the root cause of a failure that started 18 minutes
before its own. Onset order now has to agree with the graph.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine.causal import PRECEDENCE_TOLERANCE_S, analyse  # noqa: E402
from app.engine.correlate import Cluster, DependencyGraph  # noqa: E402
from app.engine.signal import Severity, Signal, SignalSource  # noqa: E402

T0 = datetime(2026, 9, 26, 10, 10, tzinfo=timezone.utc)

# carrier-service calls comms-service and agency-db; enrollment-service calls carrier-service.
GRAPH = DependencyGraph({
    ("carrier-service", "comms-service"),
    ("carrier-service", "agency-db"),
    ("enrollment-service", "carrier-service"),
})


def sig(service: str, minutes: float, i: int) -> Signal:
    return Signal(
        id=f"{service}-{i}", source=SignalSource.CLOUDWATCH_METRIC, service=service,
        severity=Severity.HIGH, timestamp=T0 + timedelta(minutes=minutes),
        message=f"{service} anomaly", metric="m", value=90.0, threshold=80.0,
        is_anomaly=True, anomaly_score=0.8,
    )


def cluster(onsets: dict[str, float]) -> Cluster:
    signals = [sig(svc, m, i) for i, (svc, m) in enumerate(onsets.items())]
    return Cluster(cluster_id=0, signals=signals)


def test_callee_that_fails_long_after_its_caller_is_not_the_root_cause():
    # carrier fails first, enrollment follows, comms only 18 minutes later
    result = analyse(cluster({"carrier-service": 0, "enrollment-service": 5, "comms-service": 18}), GRAPH)
    assert result.root_cause_service == "carrier-service"


def test_callee_that_fails_first_is_still_the_root_cause():
    # the ordinary cascade: the dependency fails first, its callers follow
    result = analyse(cluster({"comms-service": 0, "carrier-service": 1, "enrollment-service": 2}), GRAPH)
    assert result.root_cause_service == "comms-service"


def test_staggered_arrival_within_the_tolerance_does_not_change_the_verdict():
    # the caller shows up a few minutes before its failing callee: normal jitter
    # across three streams, well inside the tolerance
    assert PRECEDENCE_TOLERANCE_S >= 300
    result = analyse(cluster({"carrier-service": 0, "comms-service": 3, "enrollment-service": 4}), GRAPH)
    assert result.root_cause_service == "comms-service"
