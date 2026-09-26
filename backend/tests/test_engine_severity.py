"""Unit tests for each severity factor in isolation.

The golden-path tests already pin the *composite* score for one scenario;
these pin each factor function's own behaviour directly, at the boundaries
that matter: an empty cluster, a single service, a service with no known
criticality, a simultaneous burst, a widening window, a full vs. partial
maintenance window, and the P1-rate calibration guard.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine.causal import CausalResult  # noqa: E402
from app.engine.correlate import Cluster, DependencyGraph  # noqa: E402
from app.engine.severity import (  # noqa: E402
    BLAST_REFERENCE,
    DEFAULT_CRITICALITY,
    MaintenanceWindow,
    P1_THRESHOLD,
    P2_THRESHOLD,
    P3_THRESHOLD,
    W_BLAST,
    W_CRITICALITY,
    W_DIVERSITY,
    W_TREND,
    blast_radius,
    business_criticality,
    flap_count,
    p1_rate_warning,
    score_incident,
    signal_diversity,
    trend_direction,
)
from app.engine.signal import Severity, Signal, SignalSource

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def sig(service, seconds=0, source=SignalSource.CLOUDWATCH_LOG, template=None, metric=None) -> Signal:
    return Signal(
        id=f"{service}-{seconds}-{source}-{template}",
        source=source,
        service=service,
        severity=Severity.HIGH,
        timestamp=T0 + timedelta(seconds=seconds),
        message="x",
        metric=metric,
        template_id=template,
    )


def cluster(signals) -> Cluster:
    return Cluster(cluster_id=0, signals=list(signals))


def causal(root=None) -> CausalResult:
    return CausalResult(root_cause_service=root, root_cause_signal=None, confidence=0.9, candidates=[])


# --------------------------------------------------------------------------
# blast_radius
# --------------------------------------------------------------------------


class TestBlastRadius:
    def test_scales_toward_1_with_affected_service_count(self):
        one = blast_radius(cluster([sig("a")]), causal(), DependencyGraph())[0]
        many = blast_radius(cluster([sig(f"s{i}") for i in range(10)]), causal(), DependencyGraph())[0]
        assert 0 < one < many <= 1.0

    def test_caps_at_the_blast_reference_not_beyond(self):
        # BLAST_REFERENCE services already saturates the "affected" half.
        exactly = blast_radius(cluster([sig(f"s{i}") for i in range(int(BLAST_REFERENCE))]), causal(), DependencyGraph())[0]
        double = blast_radius(cluster([sig(f"s{i}") for i in range(int(BLAST_REFERENCE) * 2)]), causal(), DependencyGraph())[0]
        assert exactly == double  # both saturate the "affected" component identically

    def test_potential_downstream_reach_raises_the_score(self):
        # Edges run caller -> callee, so "api calls db" is ("api", "db"); the
        # services that break if db fails are db's *callers* (its ancestors).
        graph = DependencyGraph({("api", "db"), ("worker", "db")})
        c = cluster([sig("db")])
        without_root = blast_radius(c, causal(root=None), graph)[0]
        with_root = blast_radius(c, causal(root="db"), graph)[0]
        assert with_root > without_root

    def test_detail_mentions_downstream_reach_only_when_present(self):
        graph = DependencyGraph({("api", "db")})
        detail_no_reach = blast_radius(cluster([sig("db"), sig("api")]), causal(root="db"), graph)[1]
        assert "more downstream" not in detail_no_reach  # api is already affected, nothing left to reach

        detail_with_reach = blast_radius(cluster([sig("db")]), causal(root="db"), graph)[1]
        assert "more downstream" in detail_with_reach  # api hasn't fired yet but depends on db


# --------------------------------------------------------------------------
# business_criticality
# --------------------------------------------------------------------------


class TestBusinessCriticality:
    def test_picks_the_highest_not_the_average(self):
        registry = {"payment-svc": 1.0, "log-archive": 0.2}
        score, detail = business_criticality(cluster([sig("payment-svc"), sig("log-archive")]), registry)
        assert score == 1.0 and "payment-svc" in detail

    def test_unknown_service_gets_the_documented_default(self):
        score, _ = business_criticality(cluster([sig("totally-unknown-service")]), {"known": 1.0})
        assert score == DEFAULT_CRITICALITY

    def test_empty_cluster_is_handled_without_crashing(self):
        score, detail = business_criticality(cluster([]), {})
        assert score == DEFAULT_CRITICALITY and "no services" in detail


# --------------------------------------------------------------------------
# trend_direction
# --------------------------------------------------------------------------


class TestTrendDirection:
    def test_too_few_signals_is_reported_honestly_not_guessed(self):
        score, detail = trend_direction(cluster([sig("a", i) for i in range(3)]))
        assert score == 0.5 and "too few" in detail

    def test_rising_scores_higher_than_decaying(self):
        # 1 signal in the first half, 5 in the second: sharply rising.
        rising = cluster([sig("a", 0)] + [sig("a", 50 + i) for i in range(5)])
        # 5 signals in the first half, 1 in the second: decaying.
        decaying = cluster([sig("a", i) for i in range(5)] + [sig("a", 100)])
        r_score, r_detail = trend_direction(rising)
        d_score, d_detail = trend_direction(decaying)
        assert r_score > d_score
        assert "rising" in r_detail
        assert "decaying" in d_detail

    def test_steady_rate_lands_in_the_middle(self):
        steady = cluster([sig("a", i * 10) for i in range(6)])
        score, detail = trend_direction(steady)
        assert "steady" in detail
        assert 0.3 < score < 0.7

    def test_simultaneous_signals_score_high_without_dividing_by_zero(self):
        simultaneous = cluster([sig("a", 0) for _ in range(4)])
        score, detail = trend_direction(simultaneous)
        assert score == 0.8 and "simultaneously" in detail


# --------------------------------------------------------------------------
# signal_diversity
# --------------------------------------------------------------------------


class TestSignalDiversity:
    def test_one_source_family_scores_low(self):
        score, detail = signal_diversity(cluster([sig("a", source=SignalSource.APP_LOG)]))
        assert score == round(1 / 3, 3) and "log" in detail

    def test_three_families_saturates_at_1(self):
        c = cluster([
            sig("a", source=SignalSource.CLOUDWATCH_METRIC),
            sig("a", source=SignalSource.APP_LOG),
            sig("a", source=SignalSource.TRACE_SPAN),
        ])
        score, detail = signal_diversity(c)
        assert score == 1.0
        assert "metric" in detail and "log" in detail and "trace" in detail

    def test_metric_and_grafana_count_as_the_same_family(self):
        c = cluster([
            sig("a", source=SignalSource.CLOUDWATCH_METRIC),
            sig("a", source=SignalSource.GRAFANA_ALERT),
        ])
        score, _ = signal_diversity(c)
        assert score == round(1 / 3, 3)  # both collapse to "metric" - only 1 family


# --------------------------------------------------------------------------
# maintenance suppression (through score_incident, the only public path)
# --------------------------------------------------------------------------


class TestMaintenanceSuppression:
    def test_full_coverage_suppresses(self):
        window = MaintenanceWindow(services={"a", "b"}, start=T0 - timedelta(minutes=5), end=T0 + timedelta(minutes=60))
        c = cluster([sig("a"), sig("b")])
        breakdown = score_incident(c, causal(), DependencyGraph(), maintenance=[window])
        assert breakdown.suppressed and "maintenance window" in breakdown.suppression_reason
        assert "suppression" in breakdown.factors

    def test_partial_coverage_never_suppresses(self):
        """An incident that spread beyond the deploy is exactly the one someone needs to see."""
        window = MaintenanceWindow(services={"a"}, start=T0 - timedelta(minutes=5), end=T0 + timedelta(minutes=60))
        c = cluster([sig("a"), sig("b")])  # b is outside the window
        breakdown = score_incident(c, causal(), DependencyGraph(), maintenance=[window])
        assert breakdown.suppressed is False

    def test_outside_the_time_range_does_not_suppress(self):
        window = MaintenanceWindow(services={"a"}, start=T0 + timedelta(hours=2), end=T0 + timedelta(hours=3))
        breakdown = score_incident(cluster([sig("a")]), causal(), DependencyGraph(), maintenance=[window])
        assert breakdown.suppressed is False

    def test_no_windows_at_all_never_suppresses(self):
        breakdown = score_incident(cluster([sig("a")]), causal(), DependencyGraph(), maintenance=None)
        assert breakdown.suppressed is False


# --------------------------------------------------------------------------
# flap_count
# --------------------------------------------------------------------------


class TestFlapCount:
    def test_repeated_condition_counts_as_flaps(self):
        c = cluster([sig("a", i, template="T1") for i in range(4)])
        assert flap_count(c) == 4

    def test_different_conditions_do_not_inflate_the_count(self):
        c = cluster([sig("a", template="T1"), sig("a", template="T2"), sig("b", template="T1")])
        assert flap_count(c) == 1

    def test_empty_cluster_reports_one_not_zero(self):
        assert flap_count(cluster([])) == 1


# --------------------------------------------------------------------------
# score_incident: the composite is exactly the weighted sum
# --------------------------------------------------------------------------


class TestScoreIncident:
    def test_score_is_the_documented_weighted_sum_of_its_factors(self):
        c = cluster([
            sig("payment-svc", 0, source=SignalSource.CLOUDWATCH_METRIC),
            sig("payment-svc", 30, source=SignalSource.APP_LOG),
            sig("payment-svc", 90, source=SignalSource.TRACE_SPAN),
            sig("payment-svc", 91, source=SignalSource.TRACE_SPAN),
        ])
        breakdown = score_incident(c, causal(root="payment-svc"), DependencyGraph(), criticality={"payment-svc": 1.0})
        recomputed = (
            W_BLAST * breakdown.blast_radius
            + W_CRITICALITY * breakdown.business_criticality
            + W_TREND * breakdown.trend_direction
            + W_DIVERSITY * breakdown.signal_diversity
        )
        assert breakdown.score == round(min(max(recomputed, 0.0), 1.0), 3)

    def test_priority_thresholds_are_applied_correctly(self):
        # One low-criticality service with no anomaly: impact falls to the lowest band.
        low = score_incident(cluster([sig("ci-runner")]), causal(), DependencyGraph(), criticality={"ci-runner": 0.15})
        assert low.score < P3_THRESHOLD and low.priority == "P4"

        # Maximise the three weighted factors: >=5 distinct services (blast
        # radius saturates), payment-svc present (max criticality), and a
        # strong anomaly (magnitude). Trend is still reported, as context.
        c = cluster(
            [sig(f"s{i}", 0, source=SignalSource.CLOUDWATCH_METRIC) for i in range(6)]
            + [sig("payment-svc", 250 + i, source=SignalSource.APP_LOG) for i in range(10)]
            + [sig("payment-svc", 300 + i, source=SignalSource.TRACE_SPAN) for i in range(20)]
        )
        for s in c.signals:
            s.anomaly_score = 0.95
        high = score_incident(c, causal(), DependencyGraph(), criticality={"payment-svc": 1.0})
        assert high.factors["trend"].startswith("rising")
        assert high.score >= P1_THRESHOLD and high.priority == "P1"
        assert high.impact == round(high.score * 100)

    def test_score_never_leaves_the_0_1_range(self):
        breakdown = score_incident(cluster([sig("payment-svc")]), causal(), DependencyGraph(), criticality={"payment-svc": 1.0})
        assert 0.0 <= breakdown.score <= 1.0


# --------------------------------------------------------------------------
# p1_rate_warning
# --------------------------------------------------------------------------


class TestP1RateWarning:
    def test_too_few_incidents_never_warns(self):
        assert p1_rate_warning([_fake_breakdown("P1"), _fake_breakdown("P1")]) is None

    def test_high_p1_share_warns(self):
        breakdowns = [_fake_breakdown("P1")] * 4 + [_fake_breakdown("P3")]
        warning = p1_rate_warning(breakdowns)
        assert warning is not None and "calibration warning" in warning

    def test_low_p1_share_does_not_warn(self):
        breakdowns = [_fake_breakdown("P1")] + [_fake_breakdown("P3")] * 4
        assert p1_rate_warning(breakdowns) is None

    def test_suppressed_incidents_are_excluded_from_the_ratio(self):
        # 4 suppressed P1s plus 1 live P3: the live share of P1 is 0%, not 80%.
        breakdowns = [_fake_breakdown("P1", suppressed=True)] * 4 + [_fake_breakdown("P3")]
        assert p1_rate_warning(breakdowns) is None

    def test_all_suppressed_never_warns(self):
        breakdowns = [_fake_breakdown("P1", suppressed=True)] * 3
        assert p1_rate_warning(breakdowns) is None


def _fake_breakdown(priority: str, suppressed: bool = False):
    from app.engine.severity import SeverityBreakdown

    return SeverityBreakdown(
        blast_radius=0.5, business_criticality=0.5, trend_direction=0.5, signal_diversity=0.5,
        score=0.9 if priority == "P1" else 0.1, priority=priority, suppressed=suppressed,
    )
