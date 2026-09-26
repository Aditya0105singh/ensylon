import json

import pytest

from app.alert_dna import AlertDNA, MATCH_THRESHOLD


@pytest.fixture
def real_dna():
    """Against the actual seed_incident_library.json shipped with the repo —
    this is what production behavior actually does."""
    return AlertDNA()


@pytest.fixture
def tiny_library_path(tmp_path):
    library = [
        {
            "incident_id": "INC-TEST-1",
            "title": "Test seed incident",
            "symptom_pattern": "widget flux capacitor overheating, gadget thermal shutdown",
            "resolution": "replaced flux capacitor coolant",
            "resolution_minutes": 9,
            "services_affected": ["widget-service"],
        }
    ]
    path = tmp_path / "tiny_library.json"
    path.write_text(json.dumps(library), encoding="utf-8")
    return path


class TestAlertDNAConstruction:
    def test_loads_custom_library_path(self, tiny_library_path):
        dna = AlertDNA(library_path=tiny_library_path)
        assert len(dna.library) == 1
        assert dna.library_embeddings.shape[0] == 1


class TestAlertDNAMatch:
    def test_novel_incident_returns_none(self, real_dna, alert_factory):
        # Vocabulary shares essentially nothing with any seeded incident.
        alerts = [
            alert_factory(
                service="greenhouse-sensor",
                alertname="PollenCountAnomaly",
                message="seasonal pollen count exceeds botanical threshold",
            )
        ]
        assert real_dna.match(alerts) is None

    def test_matching_symptom_pattern_returns_expected_incident(self, real_dna, alert_factory):
        # Deliberately echoes INC-0389's own symptom vocabulary (connection
        # pool exhaustion / queued connections / upstream timeouts / 5xx).
        alerts = [
            alert_factory(
                service="postgres-primary",
                alertname="DBConnectionPoolExhausted",
                message="Database connection pool exhausted, connections queued",
            ),
            alert_factory(
                service="api-gateway",
                alertname="UpstreamTimeout",
                message="upstream API timeouts, HTTP 5xx spike on order endpoints",
            ),
        ]
        match = real_dna.match(alerts)
        assert match is not None
        assert match["incident_id"] == "INC-0389"
        assert match["similarity_pct"] > MATCH_THRESHOLD * 100

    def test_match_result_includes_full_library_entry_fields(self, real_dna, alert_factory):
        alerts = [
            alert_factory(
                service="postgres-primary",
                alertname="DBConnectionPoolExhausted",
                message="Database connection pool exhausted, connections queued, upstream API timeouts",
            )
        ]
        match = real_dna.match(alerts)
        assert match is not None
        assert "resolution" in match
        assert "resolution_minutes" in match
        assert "services_affected" in match

    def test_tiny_library_exact_vocabulary_match(self, tiny_library_path, alert_factory):
        dna = AlertDNA(library_path=tiny_library_path)
        alerts = [
            alert_factory(
                service="widget-service",
                alertname="FluxCapacitorOverheat",
                message="widget flux capacitor overheating, gadget thermal shutdown",
            )
        ]
        match = dna.match(alerts)
        assert match is not None
        assert match["incident_id"] == "INC-TEST-1"
        assert match["similarity_pct"] > 90  # near-identical text to the seed

    def test_tiny_library_unrelated_alert_returns_none(self, tiny_library_path, alert_factory):
        dna = AlertDNA(library_path=tiny_library_path)
        alerts = [alert_factory(service="unrelated", alertname="Foo", message="bar baz qux")]
        assert dna.match(alerts) is None
