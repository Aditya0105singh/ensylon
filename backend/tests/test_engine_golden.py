"""The golden incident must tell the same story every time.

These pin the demo's headline claims to the engine's real output:
17 signals -> 1 incident, postgres-primary as root cause, the disk decoy
rejected by the shared-context gate, P1 from the explicit score, and nothing
published without a human.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


@pytest.fixture()
def run():
    client = TestClient(app)
    body = client.post("/engine/golden").json()
    return client, body


def test_seventeen_signals_become_one_incident(run):
    _, body = run
    rep = body["report"]
    assert rep["signals_ingested"] == 18          # 17 incident signals + 1 decoy
    assert rep["incidents_formed"] == 1
    assert rep["noise_signals"] == 1
    assert len(body["queue"]) == 1


def test_report_exposes_the_pair_counts_behind_the_ratios(run):
    """A 1.000 precision is only meaningful next to how many pairs it covers."""
    _, body = run
    ev = body["report"]["evaluation"]
    assert ev["true_pairs"] > 0 and ev["predicted_pairs"] > 0
    assert ev["correct_pairs"] <= min(ev["true_pairs"], ev["predicted_pairs"])
    assert ev["pair_precision"] == round(ev["correct_pairs"] / ev["predicted_pairs"], 3)
    assert ev["pair_recall"] == round(ev["correct_pairs"] / ev["true_pairs"], 3)


def test_root_cause_is_postgres_not_the_loudest_symptom(run):
    client, body = run
    ev = client.get(f"/engine/queue/{body['queue'][0]['draft_id']}/evidence").json()
    assert ev["raw_signals"] == 17
    rc = ev["root_cause"]
    assert rc["service"] == "postgres-primary"
    top = rc["candidates"][0]
    assert top["service"] == "postgres-primary" and top["survived_counterfactual"]
    # every other candidate is a symptom rejected by the counterfactual check
    others = {c["service"] for c in rc["candidates"][1:]}
    assert others == {"order-api", "payment-svc", "checkout-bff"}
    assert set(rc["rejected_by_counterfactual"]) == others


def test_disk_warning_is_rejected_with_reasons(run):
    client, body = run
    ev = client.get(f"/engine/queue/{body['queue'][0]['draft_id']}/evidence").json()
    assert [x["service"] for x in ev["excluded"]] == ["log-archive"]
    checks = ev["excluded"][0]["checks"]
    assert checks and all(c["ok"] is False for c in checks)
    assert "log-archive" not in {s["service"] for s in ev["signals"]}


def test_every_included_signal_has_shared_context(run):
    """Time coincidence alone never groups: each signal names its gate."""
    client, body = run
    ev = client.get(f"/engine/queue/{body['queue'][0]['draft_id']}/evidence").json()
    for s in ev["signals"]:
        assert s["join"]["joined"] and s["join"]["gate"], s["service"]


def test_twelve_repeats_collapse_into_one_signal(run):
    client, body = run
    ev = client.get(f"/engine/queue/{body['queue'][0]['draft_id']}/evidence").json()
    logs = [s for s in ev["signals"] if s["source"] == "cloudwatch_log"]
    assert len(logs) == 1 and logs[0]["occurrences"] == 12


def test_p1_score_is_explainable(run):
    client, body = run
    ev = client.get(f"/engine/queue/{body['queue'][0]['draft_id']}/evidence").json()
    sev = ev["severity"]
    assert sev["priority"] == "P1" and sev["score"] >= sev["p1_threshold"]
    total = sum(f["contribution"] for f in sev["factors"])
    assert total == pytest.approx(sev["score"], abs=0.01)
    assert sum(f["weight"] for f in sev["factors"]) == pytest.approx(1.0)


def test_draft_awaits_review_and_jira_is_not_created(run):
    client, body = run
    q = body["queue"][0]
    assert q["status"] == "awaiting_review" and q["jira_key"] is None
    assert body["report"]["auto_published"] == 0


def test_golden_is_deterministic():
    client = TestClient(app)
    a = client.post("/engine/golden").json()["queue"][0]
    b = client.post("/engine/golden").json()["queue"][0]
    assert (a["priority"], a["severity_score"], a["signal_count"]) == (
        b["priority"], b["severity_score"], b["signal_count"])


def test_history_match_is_context_not_a_verdict(run):
    client, body = run
    d = client.get(f"/engine/queue/{body['queue'][0]['draft_id']}").json()
    m = d["historical_match"]
    assert m and m["incident_id"] == "INC-0417" and m["similarity_pct"] >= 40
    assert m["source"] == "seeded demo history"
    # offered as a step to consider, and it did not change the grouping or priority
    assert any("INC-0417" in s for s in d["investigation_steps"])
    assert d["priority"] == "P1" and d["signal_count"] == 6


def test_unrelated_incident_has_no_strong_history_match():
    from app.engine.history import match_history
    from app.engine.correlate import Cluster
    from app.engine.signal import Signal, SignalSource, Severity
    from datetime import datetime, timezone

    sig = Signal(id="x", source=SignalSource.CLOUDWATCH_LOG, service="thing",
                 severity=Severity.HIGH, timestamp=datetime(2026, 1, 1, tzinfo=timezone.utc),
                 message="widget calibration drifted beyond tolerance")
    assert match_history(Cluster(cluster_id=1, signals=[sig])) is None


def test_maintenance_window_suppresses_the_page_but_still_drafts():
    client = TestClient(app)
    body = client.post("/engine/scenario/maintenance").json()
    q = body["queue"][0]
    assert q["suppressed"] is True and q["status"] == "awaiting_review"
    d = client.get(f"/engine/queue/{q['draft_id']}").json()
    assert "maintenance window" in d["suppression_reason"]
    # partial coverage must NOT suppress: same incident, no window
    plain = client.post("/engine/scenario/golden").json()["queue"][0]
    assert plain["suppressed"] is False


def test_flapping_service_is_one_incident_with_a_flap_count():
    client = TestClient(app)
    body = client.post("/engine/scenario/flapping").json()
    assert body["report"]["signals_ingested"] == 4 and body["report"]["incidents_formed"] == 1
    ev = client.get(f"/engine/queue/{body['queue'][0]['draft_id']}/evidence").json()
    assert ev["severity"]["flap_count"] == 4


def test_unknown_scenario_is_a_404():
    assert TestClient(app).post("/engine/scenario/nope").status_code == 404


def test_health_reflects_a_real_golden_run(run):
    client, body = run
    h = client.get("/engine/health").json()
    assert h["status"] == "ok"
    assert h["run_loaded"] is True
    assert h["queue"]["awaiting_review"] == 1
    assert h["queue"]["awaiting_review_p1"] == 1  # golden is P1
    assert h["last_pipeline_run"]["signals_ingested"] == 18
    assert h["last_pipeline_run"]["incidents_formed"] == 1
    # golden's P1 draft must have paged - the push half of the review gate
    assert h["notifications"]["sent"] >= 1
    assert h["notifications"]["recent"][-1]["reason"] == "new_p1_incident"
    # no ALERT_WEBHOOK_URL configured in this environment -> honestly mock
    assert h["notifications"]["transport"] == "MockNotificationTransport"
    assert h["notifications"]["live"] is False
    assert h["jira"]["transport"] == "MockJiraTransport"
    assert h["jira"]["live"] is False


def test_health_never_fabricates_llm_configuration():
    """Whatever this environment's real provider keys are, /health must
    report exactly that - never a hardcoded "configured" or "not configured"."""
    from app import summarizer

    h = TestClient(app).get("/engine/health").json()
    real = [name for name, *_ in summarizer._configured_providers()]
    assert h["llm"]["configured_providers"] == real
    assert h["llm"]["live"] == (len(real) > 0)


def test_generic_ingest_fresh_starts_a_new_run_instead_of_attaching():
    """A whole file must become its own run, not late arrivals on the last one."""
    client = TestClient(app)
    client.post("/engine/golden")
    rows = [{"host": "svc-a", "time": f"2026-09-26T10:00:{i:02d}Z", "level": "error",
             "description": "connection refused"} for i in range(0, 50, 5)]
    attached = client.post("/engine/ingest/generic", json=rows).json()
    assert attached["mode"] == "attached"
    fresh = client.post("/engine/ingest/generic?fresh=true", json=rows).json()
    assert fresh["mode"] == "new_batch" and fresh["received"] == len(rows)
    assert client.get("/engine/health").json()["scenario"] == "live ingest"
