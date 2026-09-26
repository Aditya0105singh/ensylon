"""Tests for the incident explainability, playbook and ticket paths.

Several of these pin bugs that shipped earlier: a playbook that recommended
Postgres/Kubernetes checks for supercomputer memory errors and invented a
revenue figure, classifier false positives on "db" and bare numbers, CamelCase
alert names the classifier could not see into, and a real-dataset reload whose
incident count drifted with the wall clock.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "data"))
from synthetic_alert_generator import generate_batch  # noqa: E402

from app import incident_ticket  # noqa: E402
from app.clustering import EPS, cluster_alerts, group_by_label, pick_root_cause  # noqa: E402
from app.correlation_explain import build_correlation_explanation  # noqa: E402
from app.dedup import deduplicate  # noqa: E402
from app.engine.review import ReviewQueue  # noqa: E402
from app.playbook import generate_playbook  # noqa: E402
from app.risk_score import escalation_risk  # noqa: E402


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def run_pipeline(alerts: list[dict]) -> tuple[list[dict], list[dict]]:
    """The pure part of app.main's pipeline: no database, no LLM. The real
    runner rewrites the demo database, which a test must not touch."""
    unique, _ = deduplicate(alerts)
    labels, _ = cluster_alerts(unique)
    groups = group_by_label(unique, labels)
    clusters = []
    for label, members in sorted(groups.items()):
        if label == -1:
            continue
        clusters.append({
            "cluster_id": label,
            "size": len(members),
            "raw_alert_count": sum(m.get("duplicate_count", 1) for m in members),
            "root_cause": pick_root_cause(members),
            "risk": escalation_risk(members),
            "dna_match": None,
            "summary": "test summary",
            "summary_source": "template",
            "est_triage_minutes_saved": 0,
            "alerts": sorted(members, key=lambda a: a["timestamp"]),
        })
    return clusters, groups.get(-1, [])


@pytest.fixture(scope="module")
def batch() -> tuple[list[dict], list[dict]]:
    clusters, noise = run_pipeline(generate_batch(n_incidents=4, n_noise=80, seed=7))
    assert clusters, "seeded batch should form at least one incident"
    return clusters, noise


def cluster_of(alertname: str, message: str, service: str = "svc-a", **extra) -> dict:
    alert = {
        "id": f"a-{alertname}",
        "service": service,
        "alertname": alertname,
        "message": message,
        "severity": "critical",
        "timestamp": "2026-01-01T10:00:00",
    }
    return {
        "cluster_id": 1,
        "size": 1,
        "raw_alert_count": 1,
        "root_cause": alert,
        "risk": {"score": 0.8, "level": "high"},
        "dna_match": extra.get("dna_match"),
        "alerts": [alert],
    }


# --------------------------------------------------------------------------
# playbook
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("alertname", "message", "family"),
    [
        ("ddr errors detected", "30 ddr errors(s) detected and corrected on rank 0", "memory / ECC"),
        ("KERNTERM: rts: kernel terminated", "rts: kernel terminated for reason 1003", "job / kernel termination"),
        ("Lustre mount FAILED", "Lustre mount FAILED : bglio41", "filesystem / mount"),
        ("PacketLossHigh", "Packet loss 12% between subnet-a and subnet-c", "network / interconnect"),
        # regression: a bare "db" matched the --dbproperties startup flag
        ("BGLMaster has been started",
         "./BGLMaster --consoleip 10.0.0.1 --dbproperties db.properties",
         "control plane / restart"),
        # regression: "timeout" used to route a database timeout to network
        ("DBQueryTimeout", "Query exceeded 30s", "service / application"),
        # regression: CamelCase hid "disk" from the word-boundary match
        ("DiskUsageCritical", "Volume usage at 97%", "filesystem / mount"),
    ],
)
def test_playbook_classifies_by_the_incidents_own_text(alertname, message, family):
    assert generate_playbook(cluster_of(alertname, message))["failure_family"] == family


def test_bare_db_token_does_not_imply_a_database_incident():
    """A filename like db.properties is not a database failure. Deliberately has
    no restart phrase, so the earlier control-plane family cannot mask it."""
    pb = generate_playbook(cluster_of("ConfigLoaded", "read settings from /etc/app/db.properties"))
    assert pb["failure_family"] != "service / application"


def test_bare_number_in_500s_is_not_an_http_5xx():
    """An IP, port or count between 500 and 599 is not an HTTP 5xx."""
    pb = generate_playbook(cluster_of("NodeReport", "node 10.2.3.4 reported count 512 on slot 7"))
    assert pb["failure_family"] != "service / application"


def test_unmatched_incident_is_left_unclassified_not_guessed():
    pb = generate_playbook(cluster_of("BackupCompleted", "Nightly backup finished"))
    assert pb["failure_family"] is None
    assert pb["steps"], "still gives generic triage steps"


def test_playbook_does_not_invent_platform_specifics_for_supercomputer_alerts():
    pb = generate_playbook(cluster_of("ddr errors detected", "ddr errors corrected on rank 0"))
    text = " ".join(f"{s['title']} {s['description']}" for s in pb["steps"]).lower()
    for invented in ("5432", "kubectl", "docker", "5xx", "postgres", "prometheus"):
        assert invented not in text, f"playbook asserted a {invented!r} that the data never showed"


def test_playbook_has_no_fabricated_cost_figure():
    pb = generate_playbook(cluster_of("DBQueryTimeout", "timeout", service="order-api"))
    flat = repr(pb).lower()
    assert "$" not in flat and "revenue" not in flat
    assert "business_impact" not in pb


def test_no_time_estimate_without_a_historical_baseline():
    pb = generate_playbook(cluster_of("KERNTERM", "kernel terminated"))
    assert pb["estimated_resolution"] is None
    assert pb["confidence"] is None


def test_time_estimate_comes_from_the_matched_past_incident():
    dna = {"incident_id": "INC-0389", "similarity_pct": 71.2,
           "resolution": "Rolled back order-api", "resolution_minutes": 18}
    pb = generate_playbook(cluster_of("DBQueryTimeout", "timeout", dna_match=dna))
    assert pb["estimated_resolution"] == "~18 minutes"
    assert "INC-0389" in pb["resolution_basis"]
    assert any("INC-0389" in s["title"] for s in pb["steps"])


# --------------------------------------------------------------------------
# correlation explanation
# --------------------------------------------------------------------------


def test_factors_and_confidence_are_in_range(batch):
    clusters, noise = batch
    for c in clusters:
        ex = build_correlation_explanation(c, clusters, noise)
        assert 0 <= ex["confidence_pct"] <= 100
        assert {f["key"] for f in ex["factors"]} == {
            "time_proximity", "template_similarity", "service_affinity", "cohesion",
        }
        for f in ex["factors"]:
            assert 0.0 <= f["score"] <= 1.0, f
        assert ex["params"]["eps"] == EPS


def test_excluded_alerts_really_were_left_out(batch):
    clusters, noise = batch
    for c in clusters:
        members = {a["id"] for a in c["alerts"]}
        ex = build_correlation_explanation(c, clusters, noise)
        distances = [x["distance"] for x in ex["excluded"]]
        assert distances == sorted(distances), "nearest near-misses come first"
        for x in ex["excluded"]:
            assert x["id"] not in members, "an excluded alert cannot also be a member"
            assert x["reasons"], "every exclusion states why"


def test_no_trace_id_or_template_miner_claims(batch):
    """The engine has neither, so the explanation must not claim them."""
    clusters, noise = batch
    ex = build_correlation_explanation(clusters[0], clusters, noise)
    text = repr(ex).lower()
    assert "trace" not in text and "drain" not in text


# --------------------------------------------------------------------------
# ticket draft + review gate
# --------------------------------------------------------------------------


@pytest.fixture
def fresh_gate(monkeypatch):
    monkeypatch.setattr(incident_ticket, "_queue", ReviewQueue())
    monkeypatch.setattr(incident_ticket, "_approvers", {})


def test_draft_is_unpublished_until_approved(batch, fresh_gate):
    clusters, noise = batch
    t = incident_ticket.get_ticket(clusters[0], clusters, noise)
    assert t["published"] is False
    assert t["jira"]["key"] is None
    assert t["jira"]["mode"] == "simulated"


def test_approval_publishes_and_records_the_human(batch, fresh_gate):
    clusters, noise = batch
    out = incident_ticket.approve_ticket(clusters[0], clusters, noise, actor="sre@example.com")
    assert out["published"] is True
    assert out["jira"]["key"]
    # re-reading must still show who approved it
    again = incident_ticket.get_ticket(clusters[0], clusters, noise)
    assert again["jira"]["approved_by"] == "sre@example.com"
    assert any("sre@example.com" in line for line in again["audit"])


def test_approving_twice_does_not_file_a_second_ticket(batch, fresh_gate):
    clusters, noise = batch
    first = incident_ticket.approve_ticket(clusters[0], clusters, noise, actor="a@x")
    second = incident_ticket.approve_ticket(clusters[0], clusters, noise, actor="b@x")
    assert first["jira"]["key"] == second["jira"]["key"]
    assert second["jira"]["approved_by"] == "a@x", "the original approver stands"


def test_jira_labels_contain_no_spaces(batch, fresh_gate):
    """Jira rejects labels with spaces; the priority used to produce one."""
    clusters, noise = batch
    for c in clusters:
        for label in incident_ticket.get_ticket(c, clusters, noise)["labels"]:
            assert " " not in label, label


def test_ticket_reports_the_real_summary_source(batch, fresh_gate):
    clusters, noise = batch
    c = dict(clusters[0], summary_source="llm")
    assert incident_ticket.get_ticket(c, clusters, noise)["summary_source"] == "llm"


# --------------------------------------------------------------------------
# real-dataset reload determinism
# --------------------------------------------------------------------------


def test_bgl_reload_is_deterministic(monkeypatch):
    """The dataset is shifted to "now" on load. An arbitrary shift moved alerts
    across the dedup window's absolute buckets, so counts drifted per reload."""
    from datetime import datetime as real_datetime

    from app import real_data_bgl

    counts = []
    for fake_now in ("2026-09-19T10:00:07", "2026-09-19T10:02:41", "2026-09-19T11:17:59"):
        class _Clock(real_datetime):
            @classmethod
            def now(cls, tz=None):  # noqa: ARG003
                return real_datetime.fromisoformat(fake_now)

        monkeypatch.setattr(real_data_bgl, "datetime", _Clock)
        unique, _ = deduplicate(real_data_bgl.load_bgl_alerts())
        counts.append(len(unique))

    assert len(set(counts)) == 1, f"unique count drifted across reloads: {counts}"
