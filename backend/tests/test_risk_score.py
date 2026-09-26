from datetime import datetime, timedelta, timezone

import pytest

from app.risk_score import escalation_risk


def _ts(offset_seconds=0, base=None):
    base = base or datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    return base + timedelta(seconds=offset_seconds)


class TestEscalationRisk:
    def test_empty_alerts_does_not_crash(self):
        result = escalation_risk([])
        assert result["score"] == 0.0
        assert result["level"] == "low"
        assert result["services_affected"] == 0

    def test_single_alert_zero_growth_rate(self, alert_factory):
        result = escalation_risk([alert_factory(severity="critical")])
        assert result["factors"]["growth_rate"] == 0.0

    def test_result_has_expected_shape(self, cascade_factory):
        result = escalation_risk(cascade_factory(n_services=3))
        assert set(result.keys()) == {"score", "level", "factors", "services_affected"}
        assert set(result["factors"].keys()) == {"growth_rate", "severity_trend", "service_spread"}

    def test_score_is_weighted_sum_of_factors(self, cascade_factory):
        alerts = cascade_factory(n_services=3)
        result = escalation_risk(alerts)
        f = result["factors"]
        expected = round(0.40 * f["growth_rate"] + 0.35 * f["severity_trend"] + 0.25 * f["service_spread"], 3)
        assert result["score"] == expected

    def test_growth_rate_caps_at_one(self, alert_factory):
        # 10 alerts within 1 second → far beyond CAP_ALERTS_PER_MIN (5/min)
        alerts = [alert_factory(id=str(i), ts=_ts(i)) for i in range(10)]
        result = escalation_risk(alerts)
        assert result["factors"]["growth_rate"] == 1.0

    def test_service_spread_caps_at_one(self, alert_factory):
        # CAP_SERVICES=5 — 8 distinct services must still cap at 1.0
        alerts = [alert_factory(service=f"svc-{i}", ts=_ts(i)) for i in range(8)]
        result = escalation_risk(alerts)
        assert result["factors"]["service_spread"] == 1.0

    def test_service_spread_single_service(self, alert_factory):
        alerts = [alert_factory(service="only-svc", ts=_ts(i)) for i in range(3)]
        result = escalation_risk(alerts)
        assert result["factors"]["service_spread"] == pytest.approx(1 / 5, rel=1e-6)

    def test_all_critical_scores_higher_severity_trend_than_all_info(self, alert_factory):
        critical_alerts = [alert_factory(severity="critical", ts=_ts(i)) for i in range(3)]
        info_alerts = [alert_factory(severity="info", ts=_ts(i)) for i in range(3)]
        crit_result = escalation_risk(critical_alerts)
        info_result = escalation_risk(info_alerts)
        assert crit_result["factors"]["severity_trend"] > info_result["factors"]["severity_trend"]

    def test_escalating_severity_trend_scores_higher_than_deescalating(self, alert_factory):
        escalating = [
            alert_factory(severity="info", ts=_ts(0)),
            alert_factory(severity="info", ts=_ts(10)),
            alert_factory(severity="critical", ts=_ts(20)),
            alert_factory(severity="critical", ts=_ts(30)),
            alert_factory(severity="critical", ts=_ts(40)),
            alert_factory(severity="critical", ts=_ts(50)),
        ]
        deescalating = [
            alert_factory(severity="critical", ts=_ts(0)),
            alert_factory(severity="critical", ts=_ts(10)),
            alert_factory(severity="info", ts=_ts(20)),
            alert_factory(severity="info", ts=_ts(30)),
            alert_factory(severity="info", ts=_ts(40)),
            alert_factory(severity="info", ts=_ts(50)),
        ]
        esc = escalation_risk(escalating)
        deesc = escalation_risk(deescalating)
        assert esc["factors"]["severity_trend"] > deesc["factors"]["severity_trend"]

    def test_severity_trend_clamped_to_0_1_range(self, alert_factory):
        # Heavy escalation from info to critical shouldn't push the trend bonus past 1.0
        alerts = [alert_factory(severity="info", ts=_ts(i)) for i in range(3)] + [
            alert_factory(severity="critical", ts=_ts(i + 100)) for i in range(3)
        ]
        result = escalation_risk(alerts)
        assert 0.0 <= result["factors"]["severity_trend"] <= 1.0

    @pytest.mark.parametrize(
        "score_factors,expected_level",
        [
            ({"growth_rate": 1.0, "severity_trend": 1.0, "service_spread": 1.0}, "high"),  # score=1.0
            ({"growth_rate": 0.0, "severity_trend": 0.0, "service_spread": 0.0}, "low"),  # score=0.0
        ],
    )
    def test_level_thresholds_extremes(self, alert_factory, score_factors, expected_level):
        # Sanity-check the boundary constants indirectly via realistic extremes
        # rather than reaching into private helpers.
        if expected_level == "high":
            alerts = [
                alert_factory(service=f"svc-{i}", severity="critical", ts=_ts(i))
                for i in range(10)
            ]
        else:
            alerts = [alert_factory(severity="info", ts=_ts(0))]
        result = escalation_risk(alerts)
        assert result["level"] == expected_level

    def test_services_affected_counts_distinct_services(self, alert_factory):
        alerts = [
            alert_factory(service="a", ts=_ts(0)),
            alert_factory(service="a", ts=_ts(1)),
            alert_factory(service="b", ts=_ts(2)),
        ]
        result = escalation_risk(alerts)
        assert result["services_affected"] == 2

    def test_input_order_does_not_matter(self, alert_factory):
        """escalation_risk sorts internally, so callers passing unsorted
        alerts (like main.py's cluster members) get the same result."""
        alerts = [alert_factory(severity="critical", ts=_ts(i)) for i in range(4)]
        forward = escalation_risk(alerts)
        backward = escalation_risk(list(reversed(alerts)))
        assert forward == backward
