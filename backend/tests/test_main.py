"""Integration tests against the real FastAPI app via TestClient.

Every test that needs pipeline data loads it explicitly (usually
`/demo/load` with a fixed seed) rather than relying on startup timing —
see conftest.py's `client` fixture docstring for why. `_state` and the
AlertDNA singleton are module-level in app.main and persist across tests
within a session; nothing here assumes a pristine `_state` at test start.

Anything that would otherwise make a real network call (LLM providers,
webhooks) is monkeypatched — the real .env in this repo has real API keys,
and tests must never spend real API credits or depend on network access.
"""

import json
from pathlib import Path

import pytest

# Read directly rather than via app.real_data_bgl.DATA_PATH, so the expected
# count comes from the committed file itself, not from the loader under test.
BGL_DATA_PATH = Path(__file__).resolve().parents[2] / "data" / "loghub_bgl_alerts.json"


def _load_seeded_batch(client, seed=42, incidents=3, noise=20):
    resp = client.post(f"/demo/load?seed={seed}&incidents={incidents}&noise={noise}")
    assert resp.status_code == 200
    return resp.json()


class TestPipelineAndDemoLoad:
    def test_get_pipeline_shape(self, client):
        resp = client.get("/pipeline")
        assert resp.status_code == 200
        body = resp.json()
        assert set(body.keys()) >= {"dedup_stats", "clusters", "noise", "raw_alerts", "dataset"}

    def test_demo_load_populates_pipeline(self, client):
        result = _load_seeded_batch(client)
        assert result["raw_alerts"] > 0
        assert result["clusters_formed"] >= 0

        pipeline = client.get("/pipeline").json()
        assert pipeline["dataset"] == "synthetic"
        assert len(pipeline["raw_alerts"]) == result["raw_alerts"]

    def test_demo_load_same_seed_is_deterministic(self, client):
        first = _load_seeded_batch(client, seed=99)
        second = _load_seeded_batch(client, seed=99)
        assert first == second

    def test_ingest_with_real_alerts(self, client, cascade_factory):
        alerts = cascade_factory(n_services=4)
        resp = client.post("/ingest", json=alerts)
        assert resp.status_code == 200
        body = resp.json()
        assert body["raw_alerts"] == 4
        pipeline = client.get("/pipeline").json()
        assert pipeline["dataset"] == "custom-ingest"

    def test_ingest_empty_list_surfaces_the_clustering_edge_case(self, client):
        """Documents actual current behavior: POST /ingest with an empty
        list raises inside run_pipeline(), because cluster_alerts([]) raises
        (see test_clustering.py's test_empty_batch_raises_on_empty_vocabulary
        for the root cause) — in a real deployment this reaches the client as
        a 500; TestClient re-raises server exceptions by default instead of
        converting them, so the exception is asserted directly here. Not
        fixed here — flagged for the cleanup pass."""
        with pytest.raises(ValueError, match="empty vocabulary"):
            client.post("/ingest", json=[])

    def test_demo_load_real_loghub_dataset(self, client):
        """The real Loghub dataset loads end-to-end through the same pipeline
        as a synthetic batch and relabels the loaded dataset. Loghub BGL
        (BlueGene/L RAS log, POST /demo/load-bgl) replaced the earlier
        Loghub HDFS sample (POST /demo/load-real)."""
        with open(BGL_DATA_PATH, encoding="utf-8") as f:
            expected_raw = len(json.load(f))
        assert expected_raw > 0

        # Start from a different dataset, so the label check below proves the
        # BGL load switched it rather than a previous test leaving it set.
        _load_seeded_batch(client)
        assert client.get("/pipeline").json()["dataset"] == "synthetic"

        resp = client.post("/demo/load-bgl")
        assert resp.status_code == 200
        result = resp.json()
        assert result["raw_alerts"] == expected_raw
        assert 0 < result["after_dedup"] <= result["raw_alerts"]
        assert result["clusters_formed"] > 0
        assert 0 <= result["uncorrelated"] <= result["after_dedup"]

        pipeline = client.get("/pipeline").json()
        assert pipeline["dataset"] == "loghub-bgl"
        assert len(pipeline["raw_alerts"]) == expected_raw
        assert all(a["source"] == "loghub-bgl" for a in pipeline["raw_alerts"])
        assert len(pipeline["clusters"]) == result["clusters_formed"]
        # Every deduplicated alert ends up in exactly one incident or in noise.
        clustered = sum(c["size"] for c in pipeline["clusters"])
        assert clustered + len(pipeline["noise"]) == result["after_dedup"]

        status = client.get("/settings/status").json()
        assert status["dataset"] == "loghub-bgl"
        assert status["persisted_alert_count"] == expected_raw

    @pytest.mark.parametrize(
        "route",
        ["/demo/load-real", "/demo/load-aiops"],
        ids=["loghub-hdfs", "aiops-challenge"],
    )
    def test_removed_dataset_routes_are_gone(self, client, route):
        """Loghub HDFS (/demo/load-real) and AIOps Challenge 2020
        (/demo/load-aiops) were removed on purpose. BGL superseded HDFS, and
        AIOps' 81 isolated fault records never formed a single incident.
        Fails if either route is re-added, and checks that a request to one
        leaves the loaded batch alone."""
        _load_seeded_batch(client)

        assert route not in {getattr(r, "path", None) for r in client.app.routes}
        assert client.post(route).status_code in (404, 405)
        assert client.get("/pipeline").json()["dataset"] == "synthetic"


class TestAlertActions:
    def test_ack_alert_persists_and_reflects_in_pipeline(self, client):
        _load_seeded_batch(client)
        alert_id = client.get("/pipeline").json()["raw_alerts"][0]["id"]

        resp = client.post(f"/alerts/{alert_id}/ack", json={"value": True})
        assert resp.status_code == 200

        pipeline = client.get("/pipeline").json()
        acked = next(a for a in pipeline["raw_alerts"] if a["id"] == alert_id)
        assert acked["acked"] is True

    def test_assign_alert(self, client):
        _load_seeded_batch(client)
        alert_id = client.get("/pipeline").json()["raw_alerts"][0]["id"]
        client.post(f"/alerts/{alert_id}/assign", json={"assignee": "Aditya"})
        pipeline = client.get("/pipeline").json()
        assigned = next(a for a in pipeline["raw_alerts"] if a["id"] == alert_id)
        assert assigned["assignee"] == "Aditya"

    def test_dismiss_alert_overrides_status(self, client):
        _load_seeded_batch(client)
        alert_id = client.get("/pipeline").json()["raw_alerts"][0]["id"]
        client.post(f"/alerts/{alert_id}/dismiss", json={"status": "resolved"})
        pipeline = client.get("/pipeline").json()
        dismissed = next(a for a in pipeline["raw_alerts"] if a["id"] == alert_id)
        assert dismissed["status"] == "resolved"

    def test_dismiss_alert_clear_override(self, client, cascade_factory):
        # A controlled, known-"firing" alert — a random synthetic pick can
        # itself already be "suppressed" (duplicates start that way), which
        # would make clearing the override look like a no-op by coincidence.
        alerts = cascade_factory(n_services=3)
        client.post("/ingest", json=alerts)
        alert_id = alerts[0]["id"]
        assert alerts[0]["status"] == "firing"

        client.post(f"/alerts/{alert_id}/dismiss", json={"status": "suppressed"})
        pipeline = client.get("/pipeline").json()
        assert next(a for a in pipeline["raw_alerts"] if a["id"] == alert_id)["status"] == "suppressed"

        client.post(f"/alerts/{alert_id}/dismiss", json={"status": None})
        pipeline = client.get("/pipeline").json()
        assert next(a for a in pipeline["raw_alerts"] if a["id"] == alert_id)["status"] == "firing"

    def test_escalate_alert(self, client):
        _load_seeded_batch(client)
        alert_id = client.get("/pipeline").json()["raw_alerts"][0]["id"]
        client.post(f"/alerts/{alert_id}/escalate", json={"value": True})
        pipeline = client.get("/pipeline").json()
        escalated = next(a for a in pipeline["raw_alerts"] if a["id"] == alert_id)
        assert escalated["escalated"] is True

    def test_action_on_unknown_alert_id_does_not_error(self, client):
        """Documents actual behavior: alert actions never validate the id
        exists — they just persist an action row and rerun the pipeline
        over whatever's currently in the DB."""
        _load_seeded_batch(client)
        resp = client.post("/alerts/does-not-exist/ack", json={"value": True})
        assert resp.status_code == 200


class TestIncidentDetailEndpoints:
    def _first_cluster_id(self, client):
        _load_seeded_batch(client, seed=42, incidents=3, noise=5)
        clusters = client.get("/pipeline").json()["clusters"]
        assert clusters, "seed=42 must produce at least one cluster"
        return clusters[0]["cluster_id"]

    def test_forecast_success(self, client):
        cluster_id = self._first_cluster_id(client)
        resp = client.get(f"/forecast/{cluster_id}")
        assert resp.status_code == 200
        assert "forecast" in resp.json()

    def test_forecast_missing_incident_404(self, client):
        _load_seeded_batch(client)
        resp = client.get("/forecast/nonexistent-id")
        assert resp.status_code == 404

    def test_comparison_success(self, client):
        cluster_id = self._first_cluster_id(client)
        resp = client.get(f"/incidents/{cluster_id}/comparison")
        assert resp.status_code == 200
        assert "has_match" in resp.json()

    def test_comparison_missing_incident_404(self, client):
        _load_seeded_batch(client)
        resp = client.get("/incidents/nonexistent-id/comparison")
        assert resp.status_code == 404

    def test_comparison_never_fabricates_a_historical_value(self, client):
        """This endpoint used to hardcode 'CRITICAL' / '91% (HIGH)' / '18 alerts'
        as the historical side of every single match, regardless of which past
        incident actually matched — the seed library records no such fields.
        Assert those literals are gone and every number shown is either real
        (similarity, service overlap, the library's own resolution_minutes) or
        explicitly marked as an estimate."""
        resp = client.post(
            "/demo/load?scenario=db_connection_exhaustion&seed=1&incidents=3&noise=5"
        )
        assert resp.status_code == 200
        clusters = client.get("/pipeline").json()["clusters"]
        matched = next(c for c in clusters if c.get("dna_match"))
        comp = client.get(f"/incidents/{matched['cluster_id']}/comparison").json()

        assert comp["has_match"] is True
        assert set(comp["similarity_breakdown"]) == {"symptom_similarity", "service_overlap"}

        fields = {m["field"]: m for m in comp["comparison_metrics"]}
        assert "Severity" not in fields and "Risk Score" not in fields and "Raw Alert Count" not in fields
        for m in comp["comparison_metrics"]:
            assert m["historical"] not in ("CRITICAL", "91% (HIGH)", "18 alerts")

        # the historical resolution time must be the matched library entry's
        # real value, not a fallback constant
        dna = comp["historical_incident"]
        assert f"{dna['resolution_minutes']} min" in fields["Estimated triage time saved (now) vs actual resolution time (then)"]["historical"]

        # the historical "timeline" only ever had ordering, never real timestamps
        for point in comp["timeline_comparison"]["historical"]:
            assert point["time"].startswith("Symptom ")

    def test_root_cause_confidence_success(self, client):
        cluster_id = self._first_cluster_id(client)
        resp = client.get(f"/incidents/{cluster_id}/root_cause_confidence")
        assert resp.status_code == 200
        assert "candidates" in resp.json()

    def test_root_cause_confidence_missing_incident_404(self, client):
        _load_seeded_batch(client)
        resp = client.get("/incidents/nonexistent-id/root_cause_confidence")
        assert resp.status_code == 404

    def test_playbook_success(self, client):
        cluster_id = self._first_cluster_id(client)
        resp = client.get(f"/incidents/{cluster_id}/playbook")
        assert resp.status_code == 200
        assert "steps" in resp.json()

    def test_playbook_missing_incident_404(self, client):
        _load_seeded_batch(client)
        resp = client.get("/incidents/nonexistent-id/playbook")
        assert resp.status_code == 404


class TestEvaluation:
    def test_evaluation_shape(self, client):
        resp = client.get("/evaluation")
        assert resp.status_code == 200
        body = resp.json()
        assert "incident_detection_pct" in body
        assert "dna_accuracy_pct" in body
        assert len(body["per_seed"]) == body["seeds_tested"]

    def test_evaluation_is_cached_across_calls(self, client):
        first = client.get("/evaluation").json()
        second = client.get("/evaluation").json()
        assert first == second


class TestDebugSummarizerCheck:
    def test_no_providers_configured_reports_no_key(self, client, monkeypatch):
        from app import summarizer
        monkeypatch.setattr(summarizer, "_configured_providers", lambda: [])
        resp = client.get("/debug/summarizer-check")
        assert resp.status_code == 200
        assert resp.json()["status"] == "no_key"

    def test_working_provider_reports_working(self, client, monkeypatch):
        from app import summarizer
        monkeypatch.setattr(
            summarizer, "_configured_providers",
            lambda: [("groq", "fake-key", "https://fake", "fake-model")],
        )
        monkeypatch.setattr(summarizer, "_call_chat_api", lambda *a, **k: "pong")
        resp = client.get("/debug/summarizer-check")
        body = resp.json()
        assert body["status"] == "working"
        assert body["provider"] == "groq"


class TestAssistantEndpoints:
    def test_assistant_incident_not_found(self, client):
        _load_seeded_batch(client)
        resp = client.post("/assistant", json={"incident_id": "nonexistent", "question": "why?"})
        assert resp.status_code == 200  # errors are in-body, not HTTP-level
        assert resp.json()["status"] == "error"

    def test_assistant_incident_mode_template_fallback(self, client, monkeypatch):
        from app import assistant
        monkeypatch.setattr(assistant, "_configured_providers", lambda: [])
        cluster_id = TestIncidentDetailEndpoints()._first_cluster_id(client)
        resp = client.post("/assistant", json={"incident_id": str(cluster_id), "question": "explain"})
        assert resp.status_code == 200
        assert resp.json()["provider"] == "template"

    def test_assistant_workspace_mode_no_incident_id(self, client, monkeypatch):
        from app import assistant
        monkeypatch.setattr(assistant, "_configured_providers", lambda: [])
        _load_seeded_batch(client)
        resp = client.post("/assistant/workspace", json={"question": "what's the top risk?"})
        assert resp.status_code == 200
        assert resp.json()["mode"] == "workspace"

    def test_assistant_workspace_delegates_when_incident_id_given(self, client, monkeypatch):
        from app import assistant
        monkeypatch.setattr(assistant, "_configured_providers", lambda: [])
        cluster_id = TestIncidentDetailEndpoints()._first_cluster_id(client)
        resp = client.post(
            "/assistant/workspace",
            json={"incident_id": str(cluster_id), "question": "explain"},
        )
        assert resp.status_code == 200
        assert "mode" not in resp.json()  # incident-mode response shape, not workspace


class TestSettingsStatus:
    def test_shape_and_reflects_loaded_dataset(self, client):
        _load_seeded_batch(client)
        status = client.get("/settings/status").json()
        assert status["dataset"] == "synthetic"
        assert status["persisted_alert_count"] > 0
        assert "llm_configured" in status
        assert "db_path" in status
        # a bare file name, never an absolute path that would leak the host layout
        assert "/" not in status["db_path"] and "\\" not in status["db_path"]


class TestMaintenanceWindowsCRUD:
    def test_create_requires_end_after_start(self, client):
        resp = client.post("/maintenance", json={
            "name": "Bad window", "start_time": "2026-01-01T12:00:00", "end_time": "2026-01-01T11:00:00",
        })
        assert resp.status_code == 400

    def test_create_list_update_delete(self, client):
        created = client.post("/maintenance", json={
            "name": "DB maintenance", "service": "postgres-primary",
            "start_time": "2026-01-01T12:00:00", "end_time": "2026-01-01T13:00:00",
        }).json()
        assert len(client.get("/maintenance").json()) == 1

        updated = client.put(f"/maintenance/{created['id']}", json={"enabled": False})
        assert updated.json()["enabled"] is False

        client.delete(f"/maintenance/{created['id']}")
        assert client.get("/maintenance").json() == []

    def test_update_missing_window_404(self, client):
        resp = client.put("/maintenance/nonexistent", json={"enabled": True})
        assert resp.status_code == 404

    def test_active_maintenance_window_suppresses_matching_service_alerts(self, client, cascade_factory):
        """Integration of the interdependency documented in main.py's
        _apply_maintenance_windows: a window covering "now" for a given
        service must suppress that service's alerts on the next pipeline run."""
        from datetime import datetime, timedelta

        now = datetime.utcnow()
        client.post("/maintenance", json={
            "name": "Suppress postgres", "service": "postgres-primary",
            "start_time": (now - timedelta(minutes=5)).isoformat(),
            "end_time": (now + timedelta(minutes=30)).isoformat(),
        })
        alerts = cascade_factory(n_services=3, root_service="postgres-primary")
        client.post("/ingest", json=alerts)
        pipeline = client.get("/pipeline").json()
        root_alert = next(a for a in pipeline["raw_alerts"] if a["service"] == "postgres-primary")
        assert root_alert["status"] == "suppressed"
