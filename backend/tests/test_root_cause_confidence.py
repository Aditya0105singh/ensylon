from app.root_cause_confidence import build_root_cause_confidence


class TestBuildRootCauseConfidence:
    def test_falsy_cluster_returns_placeholder_shape(self):
        result = build_root_cause_confidence({})
        assert result["selected_root_cause"]["service"] == "unknown"
        assert result["candidates"] == []
        assert "reasoning" in result

    def test_none_cluster_does_not_crash(self):
        result = build_root_cause_confidence(None)
        assert result["candidates"] == []

    def test_result_shape(self, cluster_factory):
        result = build_root_cause_confidence(cluster_factory())
        assert set(result.keys()) == {
            "selected_root_cause", "candidates", "evidence", "decision_tree", "reasoning",
        }

    def test_root_cause_service_is_selected_candidate(self, cluster_factory):
        cluster = cluster_factory(root_service="postgres-primary")
        result = build_root_cause_confidence(cluster)
        winner = next(c for c in result["candidates"] if c["is_selected"])
        assert winner["service"] == "postgres-primary"
        assert result["selected_root_cause"]["service"] == "postgres-primary"

    def test_exactly_one_candidate_is_selected(self, cluster_factory):
        result = build_root_cause_confidence(cluster_factory(n_services=4, n_alerts=4))
        selected = [c for c in result["candidates"] if c["is_selected"]]
        assert len(selected) == 1

    def test_candidates_sorted_by_confidence_descending(self, cluster_factory):
        result = build_root_cause_confidence(cluster_factory(n_services=4, n_alerts=4))
        confidences = [c["confidence"] for c in result["candidates"]]
        assert confidences == sorted(confidences, reverse=True)

    def test_winner_confidence_in_70_99_range(self, cluster_factory):
        """The module comment is explicit that the winner is clamped to
        [70, 99] rather than a hardcoded flat 92 — assert the clamp holds
        instead of any specific number."""
        result = build_root_cause_confidence(cluster_factory())
        winner = next(c for c in result["candidates"] if c["is_selected"])
        assert 70 <= winner["confidence"] <= 99

    def test_non_winner_confidence_in_18_72_range(self, cluster_factory):
        result = build_root_cause_confidence(cluster_factory(n_services=3, n_alerts=3))
        losers = [c for c in result["candidates"] if not c["is_selected"]]
        assert losers  # multi-service cluster must have at least one loser
        for c in losers:
            assert 18 <= c["confidence"] <= 72

    def test_single_service_cluster_only_has_winner(self, cluster_factory):
        cluster = cluster_factory(n_services=1, n_alerts=1)
        result = build_root_cause_confidence(cluster)
        assert len(result["candidates"]) == 1
        assert result["candidates"][0]["is_selected"]

    def test_dna_match_present_boosts_dna_score_reflected_in_explanation(self, cluster_factory, dna_match_factory):
        with_dna = build_root_cause_confidence(cluster_factory(dna_match=dna_match_factory()))
        without_dna = build_root_cause_confidence(cluster_factory(dna_match=None))
        winner_with = next(c for c in with_dna["candidates"] if c["is_selected"])
        winner_without = next(c for c in without_dna["candidates"] if c["is_selected"])
        assert any("DNA" in line for line in winner_with["explanation"])
        assert any("No prior Alert DNA match" in line for line in winner_without["explanation"])

    def test_evidence_is_five_factors(self, cluster_factory):
        result = build_root_cause_confidence(cluster_factory())
        assert len(result["evidence"]) == 5
        factors = {e["factor"] for e in result["evidence"]}
        assert "Earliest Alert Timestamp" in factors

    def test_decision_tree_root_matches_selected(self, cluster_factory):
        result = build_root_cause_confidence(cluster_factory(root_service="postgres-primary"))
        assert result["decision_tree"]["root"]["service"] == "postgres-primary"
