"""Incidents are stateful: late signals attach, they never fork a second ticket."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import engine_api  # noqa: E402
from app.engine.review import ApprovalRequired  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture()
def env():
    client = TestClient(app)
    draft_id = client.post("/engine/golden").json()["queue"][0]["draft_id"]
    return client, draft_id


def test_late_matching_signal_attaches_instead_of_creating_an_incident(env):
    client, d = env
    before = client.get(f"/engine/queue/{d}").json()["signal_count"]
    out = client.post(f"/engine/queue/{d}/late-signal", json={"kind": "matching"}).json()
    assert out["attached"] is True and out["gate"]
    assert len(client.get("/engine/queue").json()) == 1          # still ONE incident
    item = client.get(f"/engine/queue/{d}").json()
    assert item["draft_id"] == d and item["updates"] == 1 and item["signal_count"] >= before


def test_unrelated_late_signal_does_not_attach(env):
    client, d = env
    before = client.get(f"/engine/queue/{d}").json()
    out = client.post(f"/engine/queue/{d}/late-signal", json={"kind": "unrelated"}).json()
    assert out["attached"] is False
    after = client.get(f"/engine/queue/{d}").json()
    assert after["signal_count"] == before["signal_count"] and after["updates"] == 0
    assert len(client.get("/engine/queue").json()) == 1


def test_after_publish_new_evidence_is_a_comment_not_a_second_issue(env):
    client, d = env
    key = client.post(f"/engine/queue/{d}/approve", json={"actor": "Reviewer"}).json()["jira_key"]
    out = client.post(f"/engine/queue/{d}/late-signal", json={"kind": "matching"}).json()
    assert out["attached"] and out["commented_on_jira"] == key
    item = client.get(f"/engine/queue/{d}").json()
    assert item["jira_key"] == key and len(item["jira_comments"]) == 1
    assert len(engine_api._state.queue.jira._transport.sent) == 1   # one issue ever created


def test_cannot_comment_on_jira_before_a_human_approved(env):
    _, d = env
    with pytest.raises(ApprovalRequired):
        engine_api._state.queue.jira.add_comment(d, "sneaky")


def test_double_approve_creates_exactly_one_issue(env):
    client, d = env
    client.post(f"/engine/queue/{d}/approve", json={"actor": "A"})
    again = client.post(f"/engine/queue/{d}/approve", json={"actor": "A"})
    assert again.status_code == 400
    assert len(engine_api._state.queue.jira._transport.sent) == 1


def test_lifecycle_moves_forward_and_resolve_needs_a_published_incident(env):
    client, d = env
    assert client.post(f"/engine/queue/{d}/resolve", json={"actor": "A"}).status_code == 400
    client.post(f"/engine/queue/{d}/approve", json={"actor": "A"})
    assert client.post(f"/engine/queue/{d}/resolve", json={"actor": "A"}).json()["lifecycle"] == "resolved"
    states = [h["state"] for h in client.get(f"/engine/queue/{d}").json()["history"]]
    assert states[:3] == ["open", "drafting", "in_review"] and states[-1] == "resolved"


def test_rejected_incident_accepts_no_late_signals(env):
    client, d = env
    client.post(f"/engine/queue/{d}/reject", json={"actor": "A", "note": "noise"})
    out = client.post(f"/engine/queue/{d}/late-signal", json={"kind": "matching"}).json()
    assert out["attached"] is False


def test_reject_adjusts_weights_for_that_pattern_and_can_be_reset(env):
    client, d = env
    from app.engine.correlate import default_weights

    client.post(f"/engine/queue/{d}/reject", json={"actor": "A", "note": "noise"})
    fb = client.get("/engine/feedback").json()
    assert fb["decisions"][0]["action"] == "reject"
    adj = fb["decisions"][0]["adjustment"]
    assert adj["after"]["time"] < adj["before"]["time"]              # loose evidence down
    assert adj["after"]["dependency"] > adj["before"]["dependency"]  # structural evidence up
    assert sum(adj["after"].values()) == pytest.approx(1.0, abs=0.01)
    assert adj["before"] == default_weights()
    assert len(fb["patterns"]) == 1
    assert client.post("/engine/feedback/reset").json()["patterns"] == []
    assert client.get("/engine/feedback").json()["patterns"] == []


def _grafana(service, trace_id=None):
    labels = {"alertname": "HighLatencyP99", "service": service, "severity": "critical"}
    if trace_id:
        labels["trace_id"] = trace_id
    return {"status": "firing", "alerts": [{
        "status": "firing", "labels": labels,
        "annotations": {"description": f"p99 latency on {service}"},
        "startsAt": "2026-08-26T14:08:00Z", "valueString": "[ var='B' labels={} value=3100.0 ]",
    }]}


def test_pushed_grafana_alert_with_context_attaches_to_the_open_incident(env):
    client, d = env
    out = client.post("/engine/ingest/grafana", json=_grafana("payment-svc")).json()
    assert out["mode"] == "attached" and out["attached"] == 1 and out["drafts"] == [d]
    assert len(client.get("/engine/queue").json()) == 1


def test_pushed_grafana_alert_without_context_is_parked_as_noise(env):
    client, d = env
    out = client.post("/engine/ingest/grafana", json=_grafana("some-other-service")).json()
    assert out["attached"] == 0 and out["parked_as_noise"] == 1
    assert client.get(f"/engine/queue/{d}").json()["updates"] == 0


def test_first_push_with_no_run_starts_a_batch():
    client = TestClient(app)
    engine_api._state.result = None
    out = client.post("/engine/ingest/grafana", json=_grafana("order-api")).json()
    assert out["mode"] == "new_batch" and out["received"] == 1
