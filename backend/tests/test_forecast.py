import pytest

from app.forecast import compute_forecast


class TestComputeForecast:
    def test_result_shape(self, cluster_factory):
        result = compute_forecast(cluster_factory())
        assert set(result.keys()) == {
            "currentRisk", "confidence", "recommendedImmediateAction",
            "predictedBlastRadius", "forecast", "reasoning",
        }
        assert len(result["forecast"]) == 3
        assert [s["minutes"] for s in result["forecast"]] == [5, 10, 15]

    def test_empty_cluster_dict_does_not_crash(self):
        result = compute_forecast({})
        assert result["currentRisk"] == 50  # risk_score default 0.5 -> 50%
        assert len(result["forecast"]) == 3

    def test_risk_projection_never_exceeds_100(self, cluster_factory):
        cluster = cluster_factory(
            risk_score=0.99,
            factors={"growth_rate": 1.0, "severity_trend": 1.0, "service_spread": 1.0},
            root_severity="critical",
        )
        result = compute_forecast(cluster)
        for step in result["forecast"]:
            assert step["risk"] <= 100

    def test_alert_count_accumulates_monotonically(self, cluster_factory):
        result = compute_forecast(cluster_factory())
        counts = [s["alerts"] for s in result["forecast"]]
        assert counts == sorted(counts)
        assert all(c >= counts[0] for c in counts)

    def test_confidence_higher_with_strong_dna_match(self, cluster_factory, dna_match_factory):
        no_match = compute_forecast(cluster_factory(dna_match=None))
        strong_match = compute_forecast(cluster_factory(dna_match=dna_match_factory(similarity_pct=95.0)))
        assert strong_match["confidence"] >= no_match["confidence"]

    def test_recommended_action_uses_dna_resolution_when_available(self, cluster_factory, dna_match_factory):
        dna = dna_match_factory(resolution="Restarted the connection pool", incident_id="INC-0389")
        result = compute_forecast(cluster_factory(dna_match=dna))
        assert "INC-0389" in result["recommendedImmediateAction"]
        assert "Restarted the connection pool" in result["recommendedImmediateAction"]

    def test_recommended_action_falls_back_by_keyword_without_dna(self, cluster_factory):
        result = compute_forecast(
            cluster_factory(dna_match=None, root_alertname="MemoryPressureCritical", root_severity="high")
        )
        assert "memory" in result["recommendedImmediateAction"].lower() or "cache" in result["recommendedImmediateAction"].lower()

    def test_known_cascade_service_produces_new_services(self, cluster_factory):
        # postgres-primary is in KNOWN_CASCADES with real downstream tiers
        cluster = cluster_factory(root_service="postgres-primary", n_services=1, n_alerts=1)
        result = compute_forecast(cluster)
        all_new = [svc for step in result["forecast"] for svc in step["newServices"]]
        assert len(all_new) > 0

    def test_unknown_root_service_uses_generic_expansion(self, cluster_factory):
        cluster = cluster_factory(root_service="totally-unmapped-service-xyz", n_services=1, n_alerts=1)
        result = compute_forecast(cluster)
        # should not raise, and should still produce 3 forecast steps
        assert len(result["forecast"]) == 3

    def test_already_affected_services_not_double_counted_as_new(self, cluster_factory):
        """A service already in the cluster's alerts shouldn't reappear in
        newServices even if it's also a cascade candidate."""
        cluster = cluster_factory(root_service="postgres-primary", n_services=3, n_alerts=3)
        existing = {a["service"] for a in cluster["alerts"]}
        result = compute_forecast(cluster)
        for step in result["forecast"]:
            for svc in step["newServices"]:
                assert svc not in existing

    def test_step_confidence_decreases_over_time(self, cluster_factory):
        result = compute_forecast(cluster_factory())
        confidences = [s["confidence"] for s in result["forecast"]]
        assert confidences[0] >= confidences[1] >= confidences[2]

    def test_reasoning_is_nonempty_list_of_strings(self, cluster_factory):
        result = compute_forecast(cluster_factory())
        assert isinstance(result["reasoning"], list)
        assert len(result["reasoning"]) > 0
        assert all(isinstance(r, str) for r in result["reasoning"])
